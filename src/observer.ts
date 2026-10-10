import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';

// The only stand integration in public runtime: an explicitly owned loopback proxy.
export function observerEnvironment(root: string): NodeJS.ProcessEnv {
  const file = join(root, 'observer.json');
  if (!existsSync(file)) return {};
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const proxy = typeof value.proxy === 'string' ? value.proxy : '';
  const ca = typeof value.ca === 'string' ? value.ca : '';
  const url = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(proxy);
  let owned = false;
  try {
    const path = relative(realpathSync(root), realpathSync(ca));
    owned = !!path && !path.startsWith('..') && !isAbsolute(path) && statSync(ca).isFile();
  } catch { /* Missing or foreign CA fails closed. */ }
  if (!url || Number(url[1]) < 1 || Number(url[1]) > 65535 || !owned)
    throw Error('Observer must be own local proxy and certificate');
  return { ZCODE_HTTP_PROXY: proxy, ZCODE_AGENT_CA_CERT: ca };
}
