/** Viewer-facing identity; never part of the policy observation. */
export function policyPlayerName(
  version: string,
  mode: string,
  suffix?: "A" | "B",
): string {
  const name = `${mode} ${version.replace(/^warbook-/, "")}${suffix ? ` ${suffix}` : ""}`;
  if (/[:,\r\n]/.test(name))
    throw new Error("Player identity contains replay delimiters");
  return name;
}
