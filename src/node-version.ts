// Shared by the executable guard and host entry; no startup is performed here.
export function assertHostNode(version: string = process.versions.node): void {
  const match = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  if (!match || !((major === 24 && minor >= 22) || major === 26)) {
    throw new Error(`Unsupported host Node ${version}; required ^24.22.0 || ^26.0.0`);
  }
}
