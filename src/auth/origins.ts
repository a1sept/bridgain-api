import type { AppKind } from "./security.js";

export function allowsOrigin(app: AppKind, received: string | undefined, primary: string) {
  if (!received || received === "null") return false;
  const additional = process.env[app === "client" ? "CLIENT_ADDITIONAL_ORIGINS" : "DEVELOPER_ADDITIONAL_ORIGINS"] || "";
  return [primary, ...additional.split(",").map((value) => value.trim()).filter(Boolean)]
    .some((configured) => {
      try {
        const url = new URL(configured);
        return ["http:", "https:"].includes(url.protocol) && url.origin === received;
      } catch {
        return false;
      }
    });
}
