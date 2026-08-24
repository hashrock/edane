/**
 * テスト全体のUI言語を en に固定する。
 *
 * アプリはブラウザ言語からUI言語を自動判定する（application/i18n.ts の
 * detectLocale）ので、実行マシンのロケール次第でテストの期待文言が揺れて
 * しまう。CIのchromium（en-US）と同じ英語に明示的に固定して、日本語環境の
 * 開発マシンでも同じ結果になるようにする。文言のアサーションは英語で書く。
 * （日本語カタログ自体の検証は app/application/i18n.test.ts が行う。）
 */
import { setLocale } from "./app/application/i18n";

setLocale("en", undefined);
