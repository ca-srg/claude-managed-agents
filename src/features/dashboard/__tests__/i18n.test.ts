import { describe, expect, it } from "bun:test";
import { localeFromAcceptLanguageHeader, localeFromCookieHeader } from "@/features/dashboard/i18n";

describe("localeFromAcceptLanguageHeader", () => {
  it("returns null when header is missing or empty", () => {
    expect(localeFromAcceptLanguageHeader(undefined)).toBeNull();
    expect(localeFromAcceptLanguageHeader("")).toBeNull();
  });

  it("returns ja when ja is the primary preference", () => {
    expect(localeFromAcceptLanguageHeader("ja")).toBe("ja");
    expect(localeFromAcceptLanguageHeader("ja-JP")).toBe("ja");
    expect(localeFromAcceptLanguageHeader("ja,en-US;q=0.9,en;q=0.8")).toBe("ja");
  });

  it("returns en when en is the primary preference", () => {
    expect(localeFromAcceptLanguageHeader("en-US,en;q=0.9")).toBe("en");
  });

  it("respects qvalue ordering when ja has higher q than en", () => {
    expect(localeFromAcceptLanguageHeader("en;q=0.8,ja;q=0.9")).toBe("ja");
  });

  it("falls back to the next supported entry when the first is unsupported", () => {
    expect(localeFromAcceptLanguageHeader("fr-FR,de;q=0.9,ja;q=0.5,en;q=0.3")).toBe("ja");
  });

  it("ignores wildcards and unsupported locales", () => {
    expect(localeFromAcceptLanguageHeader("*")).toBeNull();
    expect(localeFromAcceptLanguageHeader("fr,de;q=0.9")).toBeNull();
  });

  it("treats q=0 as not acceptable", () => {
    expect(localeFromAcceptLanguageHeader("ja;q=0,en;q=0.5")).toBe("en");
    expect(localeFromAcceptLanguageHeader("ja;q=0")).toBeNull();
  });

  it("is case-insensitive for the language tag", () => {
    expect(localeFromAcceptLanguageHeader("JA-jp")).toBe("ja");
    expect(localeFromAcceptLanguageHeader("EN-US")).toBe("en");
  });

  it("uses header order to break q ties", () => {
    expect(localeFromAcceptLanguageHeader("ja,en")).toBe("ja");
    expect(localeFromAcceptLanguageHeader("en,ja")).toBe("en");
  });
});

describe("localeFromCookieHeader interplay", () => {
  it("returns the cookie value when set, independent of Accept-Language", () => {
    expect(localeFromCookieHeader("dashboard_locale=en")).toBe("en");
    expect(localeFromCookieHeader("dashboard_locale=ja")).toBe("ja");
  });

  it("returns null when the cookie is absent", () => {
    expect(localeFromCookieHeader(undefined)).toBeNull();
    expect(localeFromCookieHeader("other=value")).toBeNull();
  });

  it("ignores malformed locale cookie values", () => {
    expect(localeFromCookieHeader("dashboard_locale=%E0%A4%A")).toBeNull();
    expect(localeFromCookieHeader("dashboard_locale=%; dashboard_locale=ja")).toBe("ja");
  });
});
