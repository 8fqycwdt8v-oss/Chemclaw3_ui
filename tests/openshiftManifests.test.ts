// @vitest-environment node

/**
 * `deploy/openshift/` — the example manifests — held to the code they configure.
 *
 * An example nobody checks is read, copied and wrong: an env name the BFF never reads is a setting
 * that silently does nothing (`SANDBOX_HOST` for `SANDBOX_BIND_HOST` boots clean and binds the
 * default), a Route targeting a port name the Service lacks routes nowhere, and an origin that is
 * not the Route's host is a frame that stays blank. So the YAML is *parsed* — not grepped — and
 * every fact the README says about it is asserted here: names against `server/config.ts` and
 * `Jenkinsfile`, ports against `PORT`/`SANDBOX_PORT`, origins against the Routes' hosts, and, last,
 * the Deployment's environment booted through `server/config.ts` itself, which must start with the
 * sandbox on and refuse nothing.
 */

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAll } from 'js-yaml';

const DIR = 'deploy/openshift';

interface Doc {
  kind: string;
  metadata: { name: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}
interface Container {
  name: string;
  env: { name: string; value: string }[];
  ports: { name: string; containerPort: number }[];
  readinessProbe: { httpGet: { path: string; port: string } };
  livenessProbe: { httpGet: { path: string; port: string } };
  startupProbe?: { httpGet: { path: string; port: string } };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}
interface RouteSpec {
  host: string;
  to: { kind: string; name: string };
  port: { targetPort: string };
  tls: { termination: string; insecureEdgeTerminationPolicy: string };
}

const docs: Doc[] = readdirSync(DIR)
  .filter((file) => file.endsWith('.yaml'))
  .flatMap((file) => loadAll(readFileSync(`${DIR}/${file}`, 'utf8')) as Doc[]);

const one = (kind: string): Doc => {
  const found = docs.filter((d) => d.kind === kind);
  expect(found, kind).toHaveLength(1);
  return found[0]!;
};

const deployment = one('Deployment');
const service = one('Service');
const routes = docs.filter((d) => d.kind === 'Route');
const template = deployment.spec.template as {
  spec: { containers: Container[]; volumes?: { name: string; secret?: { secretName: string } }[] };
};
const container = template.spec.containers[0]!;
const env = Object.fromEntries(container.env.map((e) => [e.name, String(e.value)]));
const routeSpec = (route: Doc): RouteSpec => route.spec as unknown as RouteSpec;

/**
 * Every environment variable `server/config.ts` reads, by the readers it reads them with. A secret
 * is read from `<NAME>` or from the file `<NAME>_FILE` names, so both spellings are the BFF's.
 */
const configNames = new Set(
  [
    ...readFileSync('server/config.ts', 'utf8').matchAll(
      /\b(str|num|bool|secret)\('([A-Z0-9_]+)'/g,
    ),
  ].flatMap((m) => (m[1] === 'secret' ? [m[2], `${m[2]}_FILE`] : [m[2]])),
);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the example OpenShift manifests', () => {
  it('found the three kinds the README lists', () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(['Deployment', 'Route', 'Route', 'Service']);
    // The reader did read something: a name every BFF reads.
    expect(configNames.has('SANDBOX_BIND_HOST')).toBe(true);
  });

  it('sets only variables the BFF reads, and every one the sandbox needs', () => {
    for (const name of Object.keys(env)) expect(configNames, name).toContain(name);
    for (const name of [
      'PORT',
      'APP_ORIGIN',
      'SANDBOX_ORIGIN',
      'SANDBOX_PORT',
      'SANDBOX_BIND_HOST',
      'HTML_SCRIPTS_DEFAULT',
      // The token handler: what it signs in against, and where it finds its client secret.
      'AUTH_MODE',
      'ENTRA_CLIENT_SECRET_FILE',
    ]) {
      expect(env, name).toHaveProperty(name);
    }
  });

  it('names what Jenkins re-points', () => {
    const pipeline = readFileSync('Jenkinsfile', 'utf8');
    expect(pipeline).toContain(`defaultValue: '${deployment.metadata.name}'`);
    // `oc set image deployment/… <container>=<image>`: the container name is the left of the `=`.
    expect(pipeline).toMatch(new RegExp(`'${container.name}=\\$\\{params\\.IMAGE_REGISTRY\\}`));
  });

  it('opens the app and the sandbox on the ports the BFF listens on, by name', () => {
    const ports = Object.fromEntries(container.ports.map((p) => [p.name, p.containerPort]));
    expect(ports).toEqual({ http: Number(env.PORT), sandbox: Number(env.SANDBOX_PORT) });
    expect(ports.http).not.toBe(ports.sandbox);
    const servicePorts = service.spec.ports as { name: string; targetPort: string }[];
    expect(servicePorts.map((p) => [p.name, p.targetPort])).toEqual([
      ['http', 'http'],
      ['sandbox', 'sandbox'],
    ]);
  });

  it('probes the app port for readiness and liveness, and the sandbox port for its page', () => {
    expect(container.readinessProbe.httpGet).toEqual({ path: '/readyz', port: 'http' });
    expect(container.livenessProbe.httpGet).toEqual({ path: '/healthz', port: 'http' });
    expect(container.startupProbe?.httpGet).toEqual({ path: '/sandbox/frame', port: 'sandbox' });
  });

  it('routes two hosts, both edge TLS with a redirect, and the sandbox without a cookie', () => {
    const byPort = Object.fromEntries(
      routes.map((route) => [routeSpec(route).port.targetPort, route]),
    );
    expect(Object.keys(byPort).sort()).toEqual(['http', 'sandbox']);
    for (const route of routes) {
      const spec = routeSpec(route);
      expect(spec.to).toEqual({ kind: 'Service', name: service.metadata.name });
      expect(spec.tls).toEqual({ termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' });
    }
    const app = routeSpec(byPort.http!);
    const sandbox = routeSpec(byPort.sandbox!);
    expect(app.host).not.toBe(sandbox.host);
    expect(
      byPort.sandbox!.metadata.annotations?.['haproxy.router.openshift.io/disable_cookies'],
    ).toBe('true');
    // The origins are the Routes' hosts, over https, exactly.
    expect(env.APP_ORIGIN).toBe(`https://${app.host}`);
    expect(env.SANDBOX_ORIGIN).toBe(`https://${sandbox.host}`);
    // A separate registrable domain, as the README recommends — not a subdomain of the app's.
    const site = (host: string): string => host.split('.').slice(-2).join('.');
    expect(site(sandbox.host)).not.toBe(site(app.host));
  });

  it('mounts the client secret it names, from a Secret, read-only, and keeps it out of env', () => {
    const file = env.ENTRA_CLIENT_SECRET_FILE ?? '';
    const mount = container.volumeMounts?.find((m) => file.startsWith(`${m.mountPath}/`));
    expect(mount, 'a mount holding the secret file').toBeDefined();
    expect(mount?.readOnly).toBe(true);
    const volume = template.spec.volumes?.find((v) => v.name === mount?.name);
    expect(volume?.secret?.secretName).toBeTruthy();
    // The secret itself is never a literal in a manifest.
    expect(Object.keys(env)).not.toContain('ENTRA_CLIENT_SECRET');
  });

  it('keeps a browser on one pod, because sessions live in that pod’s memory', () => {
    const appRoute = routes.find((r) => routeSpec(r).port.targetPort === 'http');
    expect(appRoute?.metadata.annotations?.['haproxy.router.openshift.io/disable_cookies']).toBe(
      'false',
    );
  });

  it('boots, with this environment, with the sandbox on and nothing refused', async () => {
    // The file is the Secret's mount; here, a stand-in with the same name's contents.
    const secretFile = join(mkdtempSync(join(tmpdir(), 'oidc-')), 'client-secret');
    writeFileSync(secretFile, 'not-a-real-secret');
    for (const [name, value] of Object.entries({ ...env, ENTRA_CLIENT_SECRET_FILE: secretFile })) {
      vi.stubEnv(name, value);
    }
    vi.resetModules();
    const { cfg, validateConfig } = await import('../server/config.ts');
    expect(validateConfig(cfg)).toEqual([]);
    expect(cfg.sandboxEnabled).toBe(true);
    expect(cfg.htmlScriptsDefault).toBe(true);
    expect(cfg.port).toBe(Number(env.PORT));
    expect(cfg.sandboxPort).toBe(Number(env.SANDBOX_PORT));
  });
});
