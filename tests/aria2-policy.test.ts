import { describe, expect, test } from "bun:test";
import { aria2NetworkPolicyArgs } from "../src/lib/server/aria2-policy";

describe("aria2 torrent network policy", () => {
  test("fails closed when a VPN interface is not configured", () => {
    expect(() => aria2NetworkPolicyArgs({}, ["lo", "eth0"])).toThrow("configure TORPLEX_VPN_INTERFACE");
  });

  test("fails closed when the configured VPN interface is unavailable", () => {
    expect(() => aria2NetworkPolicyArgs({ TORPLEX_VPN_INTERFACE: "wg-torplex" }, ["lo", "eth0"]))
      .toThrow("VPN interface wg-torplex is unavailable");
  });

  test("binds aria2 and prevents post-completion seeding", () => {
    expect(aria2NetworkPolicyArgs({ TORPLEX_VPN_INTERFACE: "wg-torplex" }, ["lo", "wg-torplex"]))
      .toEqual([
        "--seed-time=0",
        "--bt-hash-check-seed=false",
        "--max-upload-limit=1",
        "--disable-ipv6=true",
        "--interface=wg-torplex",
      ]);
  });

  test("requires an explicit opt-out to run without a VPN", () => {
    expect(aria2NetworkPolicyArgs({ TORPLEX_REQUIRE_VPN: "false" }, ["lo", "eth0"]))
      .not.toContain("--interface=eth0");
  });
});
