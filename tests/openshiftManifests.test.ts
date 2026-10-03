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

import { readFileSync, readdirSync } from 'node:fs';
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
const template = deployment.spec.template as { spec: { containers: Container[] } };
const container = template.spec.containers[0]!;
const env = Object.fromEntries(container.env.map((e) => [e.name, String(e.value)]));
const routeSpec = (route: Doc): RouteSpec => route.spec as unknown as RouteSpec;

/** Every environment variable `server/config.ts` reads, by the three readers it reads them with. */
const configNames = new Set(
  [...readFileSync('server/config.ts', 'utf8').matchAll(/\b(?:str|num|bool)\('([A-Z0-9_]+)'/g)].map(
    (m) => m[1],
  ),
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

  it('boots, with this environment, with the sandbox on and nothing refused', async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    const { cfg, validateConfig } = await import('../server/config.ts');
    expect(validateConfig(cfg)).toEqual([]);
    expect(cfg.sandboxEnabled).toBe(true);
    expect(cfg.htmlScriptsDefault).toBe(true);
    expect(cfg.port).toBe(Number(env.PORT));
    expect(cfg.sandboxPort).toBe(Number(env.SANDBOX_PORT));
  });
});
