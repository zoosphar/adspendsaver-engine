const AD_PARAMS = [
  "fbclid",
  "gclid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ttclid",
  "msclkid",
  "li_fat_id",
  "twclid",
  "sclid",
  "dclid",
  "wbraid",
  "gbraid",
];

export function extractAdParams(url: string): Record<string, string> {
  try {
    const parsed = new URL(url);
    const params: Record<string, string> = {};
    for (const key of AD_PARAMS) {
      const value = parsed.searchParams.get(key);
      if (value) {
        params[key] = value;
      }
    }
    return params;
  } catch {
    return {};
  }
}

export function compareAdParams(
  original: Record<string, string>,
  final: Record<string, string>
): { preserved: boolean; missingParams: string[] } {
  const missingParams: string[] = [];
  for (const key of Object.keys(original)) {
    if (!final[key]) {
      missingParams.push(key);
    }
  }
  return {
    preserved: missingParams.length === 0,
    missingParams,
  };
}

export function getPageUrlHash(url: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(url);
  return hasher.digest("hex").slice(0, 16);
}
