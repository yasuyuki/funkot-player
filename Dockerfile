FROM rust:1.93-slim-trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    libclang-dev \
    pkg-config \
    libasound2-dev \
    openjdk-21-jdk-headless nodejs npm python3 \
    curl unzip ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64

ARG NDK_VERSION=r27c
RUN curl -fsSL -o /tmp/ndk.zip \
      "https://dl.google.com/android/repository/android-ndk-${NDK_VERSION}-linux.zip" \
 && unzip -q /tmp/ndk.zip -d /opt \
 && mv "/opt/android-ndk-${NDK_VERSION}" /opt/android-ndk \
 && rm /tmp/ndk.zip

ENV ANDROID_NDK_HOME=/opt/android-ndk
ENV NDK_HOME=/opt/android-ndk
ENV NDK_SYSROOT=/opt/android-ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot

# bindgen needs a libclang; the NDK ships only the clang driver and the
# sanitizer runtimes, so use the host one and give it the NDK sysroot.
# signalsmith's wrapper.h includes nothing but stddef.h/stdbool.h, which come
# from the host clang's own resource dir.
RUN ln -s "$(dirname "$(ls /usr/lib/llvm-*/lib/libclang.so | head -1)")" /opt/libclang
ENV LIBCLANG_PATH=/opt/libclang
ENV BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android="--sysroot=$NDK_SYSROOT"

# The linker, CC/CXX and the 16 KB page-size flag are NOT set here: the Tauri
# CLI fills those env vars itself from tauri.conf.json (see minSdkVersion) and
# would override anything set at this level. The alignment flag is emitted from
# src-tauri/build.rs instead, which is additive.

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk

ARG CMDLINE_TOOLS=commandlinetools-linux-13114758_latest.zip
RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && curl -fsSL -o /tmp/cmdline.zip "https://dl.google.com/android/repository/${CMDLINE_TOOLS}" \
 && unzip -q /tmp/cmdline.zip -d "$ANDROID_HOME/cmdline-tools" \
 && mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest" \
 && rm /tmp/cmdline.zip

ENV PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

RUN yes | sdkmanager --licenses >/dev/null \
 && sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" >/dev/null

RUN rustup component add clippy
RUN rustup target add aarch64-linux-android

RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    librsvg2-dev \
    libxdo-dev \
    libssl-dev \
    libasound2-plugins \
    pulseaudio-utils \
    xdotool \
    imagemagick \
    # rfd's Linux folder picker talks to xdg-desktop-portal first, then
    # zenity. The portal is not in this container; without zenity the
    # dialog never appears and the UI only toasts 「変更しませんでした」.
    zenity \
    fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# ImageMagick's Debian policy denies every coder except GIF/JPEG/PNG/WEBP, and
# that includes the X coder `import` reads the screen through -- so capturing a
# window fails with "error/import.c/ImportImageCommand". This is a throwaway
# build container with nothing to protect, so point it at an empty policy.
RUN mkdir -p /etc/imagemagick-permissive \
 && printf '<policymap>\n</policymap>\n' > /etc/imagemagick-permissive/policy.xml
ENV MAGICK_CONFIGURE_PATH=/etc/imagemagick-permissive

# ALSA has no default device here, and cpal asks for "default". Without this the
# desktop build fails to open a stream instead of reaching PulseAudio.
RUN printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > /etc/asound.conf

WORKDIR /work/funkot-player
