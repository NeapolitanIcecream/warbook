export interface ClientBuild {
  version: string;
  baseUrl: string;
  bundleSha256: string;
}
export const LEGACY_CLIENT: ClientBuild = {
  version: "0.84.0",
  baseUrl: "https://game.chronodivide.com",
  bundleSha256:
    "b937a130b6a1a6c9619b159769580331e08e7059bb2181758aef243753ba1bd1",
};
// game-api 0.79.0 contains engine 0.83.3. Use the official archive matching that engine.
export const PINNED_CLIENT: ClientBuild = {
  version: "0.83.3",
  baseUrl: "https://game.chronodivide.com/old/v0.83.3",
  bundleSha256:
    "ee8233214375553b12d88168c5241995a90d9a85217af2171b15a2dfa976c09c",
};
export const CLIENT_BUILDS = new Map(
  [PINNED_CLIENT, LEGACY_CLIENT].map((client) => [client.version, client]),
);
export const SDK_RESOURCE_SHA =
  "0c359a661001b463fc29d4b4596ba8054a4cc2d05d92a90fedf6d71dff6162a8";
