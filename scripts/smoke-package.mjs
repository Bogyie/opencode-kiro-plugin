const mod = await import("../dist/index.js")

if (mod.default?.id !== "kiro" || typeof mod.default.server !== "function") {
  throw new Error("Default package export is not an OpenCode plugin module.")
}

for (const name of [
  "createKiroPlugin",
  "createKiroFetch",
  "ModelResolver",
  "KiroAcpTransport",
  "CodeWhispererKiroTransport",
]) {
  if (!(name in mod)) {
    throw new Error(`Missing named package export: ${name}`)
  }
}

console.log("ok package import smoke")
