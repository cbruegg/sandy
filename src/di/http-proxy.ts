import type { HttpProxyLayerInput, HttpProxyLayerResult } from "./types.js";
import { ProxyAccess } from "../proxy-access.js";
import { createCertificateAuthority } from "../http/ca.js";
import { HttpTokenAuthorizer } from "../http/token-authorizer.js";
import { ProxyAuthService } from "../http/proxy-auth-service.js";

export async function createHttpProxyLayer(input: HttpProxyLayerInput): Promise<HttpProxyLayerResult> {
  const { config, sessionStore, persistentApprovalStore } = input;

  const proxyAccess = new ProxyAccess();
  const httpTokensEnabled = Object.keys(config.httpTokens).length > 0;

  const certificateAuthority = httpTokensEnabled ? await createCertificateAuthority() : null;

  const httpTokenAuthorizer = new HttpTokenAuthorizer(
    sessionStore,
    persistentApprovalStore,
  );

  const proxyAuthService = httpTokensEnabled
    ? new ProxyAuthService({
      access: proxyAccess,
      httpTokens: config.httpTokens,
      authorizeHttpTokenUse: (input) => httpTokenAuthorizer.authorizeHttpTokenUse(input),
    })
    : null;

  const stop = async (): Promise<void> => {
    // Certificate authority and proxy auth service have no explicit teardown.
  };

  return {
    name: "http-proxy",
    proxyAccess,
    httpTokensEnabled,
    certificateAuthority,
    httpTokenAuthorizer,
    proxyAuthService,
    stop,
  };
}