import { networkInterfaces } from "node:os";

type Environment = Record<string, string | undefined>;

function enabled(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

export function aria2NetworkPolicyArgs(
  environment: Environment = process.env,
  availableInterfaces = Object.keys(networkInterfaces()),
) {
  const requireVpn = enabled(environment.TORPLEX_REQUIRE_VPN, true);
  const vpnInterface = (environment.TORPLEX_VPN_INTERFACE ?? "").trim();

  if (requireVpn && !vpnInterface) {
    throw new Error(
      "Torrent networking is disabled: configure TORPLEX_VPN_INTERFACE or explicitly set TORPLEX_REQUIRE_VPN=false",
    );
  }
  if (vpnInterface && !availableInterfaces.includes(vpnInterface)) {
    throw new Error(`Torrent networking is disabled: VPN interface ${vpnInterface} is unavailable`);
  }

  return [
    "--seed-time=0",
    "--bt-hash-check-seed=false",
    "--max-upload-limit=1",
    "--disable-ipv6=true",
    ...(vpnInterface ? [`--interface=${vpnInterface}`] : []),
  ];
}
