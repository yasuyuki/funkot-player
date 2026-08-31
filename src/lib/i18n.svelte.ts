// The current UI language, and the message catalogue that follows from it.
//
// Components read `i18n.t.<key>`. Because `locale` is `$state` and `t` reads
// it through a getter, that access registers as a dependency: switching the
// language re-renders every component that shows text, with no per-component
// subscription.
//
// The initial value is resolved synchronously from the platform locale at
// module load, because the first render happens well before `settings.json`
// can be read over IPC. `state.svelte.ts`'s `#init` overrides it once the
// stored choice arrives (see `loadLocale` there).
import { detectLocale, type Locale } from "./locale";
import { en, type Messages } from "./locales/en";
import { ja } from "./locales/ja";
import { id } from "./locales/id";

const CATALOGS: Record<Locale, Messages> = { en, ja, id };

class I18n {
  locale = $state<Locale>(detectLocale(globalThis.navigator?.language));

  get t(): Messages {
    return CATALOGS[this.locale];
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }
}

export const i18n = new I18n();
