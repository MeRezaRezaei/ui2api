export function validatePackage(pkgDir: string): { ok: boolean; errors: string[] };
export function validatePackage(manifest: Record<string, unknown>, moduleText: string): string | null;
export function validatePackage(pkgDirOrManifest: string | Record<string, unknown>, moduleText?: string): { ok: boolean; errors: string[] } | string | null;
export function validateManifest(manifest: Record<string, unknown>, moduleText: string): string | null;
