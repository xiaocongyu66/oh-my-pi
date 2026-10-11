/**
 * `bun test` preload (bunfig [test].preload): pin UI translations to English
 * regardless of the machine locale.
 *
 * The i18n engine treats LANG as a locale signal, so on a zh-locale host every
 * `t()`-wrapped string in assertions would render Chinese and pre-existing
 * tests that assert English UI text would fail for reasons unrelated to the
 * change under test. `OMP_LANGUAGE_ENFORCE_EN` suppresses the LANG source and
 * `OMP_LANGUAGE` is deleted so an explicit developer override cannot leak into
 * test runs either. The i18n engine's own tests delete both per case and
 * install explicit providers/env, so they are unaffected.
 */
process.env.OMP_LANGUAGE_ENFORCE_EN ??= "1";
delete process.env.OMP_LANGUAGE;
