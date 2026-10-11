# @oh-my-pi/pi-i18n

Natural-key i18n engine: the English UI string IS the key.

Call sites wrap user-visible strings with `t('...')`; when the active locale pack has an entry, its translation is returned, otherwise the English string passes through unchanged. English needs no pack entry and migration is incremental — wrapping a string in `t()` works with or without a translation.

Locale resolution order: the registered locale provider (settings-injected), `OMP_LANGUAGE`, `LANG` (suppressed by `OMP_LANGUAGE_ENFORCE_EN`), then `'en'`. Translations live in flat JSON packs (`locales/<tag>.json`) using `{{name}}` placeholders; the package stays dependency-free because consumers inject a locale provider instead of this package importing their settings.

## Usage

```ts
import { t, tCount } from "@oh-my-pi/pi-i18n";

t("Signing in to {{provider}}", { provider: "GitHub" });
tCount("{{count}} archived", "{{count}} archived", { count: 3 });
```

`registerLocaleProvider(() => settings.ui.locale)` pins the active language at runtime; `resetI18n()` clears the memoized resolution (used by `/language`).

Built for [omp](https://github.com/can1357/oh-my-pi)'s terminal UI, but the engine is plain TypeScript with no runtime dependencies.
