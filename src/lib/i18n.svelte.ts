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
