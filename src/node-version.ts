// Shared by the executable guard and host entry; no startup is performed here.
export function assertHostNode(version: string = process.versions.node): void {
  const match = /^([1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const major = Number(match?.[1]), minor = Number(match?.[2]);
  if (!match || !((major === 22 && minor >= 19) || major === 24 || major === 26)) {
    throw new Error(`Unsupported host Node ${version}; required ^22.19.0 || ^24.0.0 || ^26.0.0`);
  }
}
