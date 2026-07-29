import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { randomBytes } from "node:crypto";

export function getLanIp(): string {
  const ifaces = networkInterfaces();

  const preferred = ["en0", "en1", "eth0", "wlan0", "Wi-Fi", "WiFi", "Ethernet"];
  for (const name of preferred) {
    const addrs = ifaces[name];
    if (!addrs) continue;
    const ipv4 = addrs.find(
      (a): a is NetworkInterfaceInfo => a.family === "IPv4" && !a.internal,
    );
    if (ipv4) return ipv4.address;
  }

  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    const ipv4 = addrs.find(
      (a): a is NetworkInterfaceInfo => a.family === "IPv4" && !a.internal,
    );
    if (ipv4) return ipv4.address;
  }

  return "127.0.0.1";
}

export function generateToken(): string {
  return randomBytes(16).toString("hex");
}
