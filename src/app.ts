// Composition root: wires the customer's configuration into a running company.
import path from 'node:path';
import type { Config } from './config/config.js';
import { GitHubCodeHost, LocalCodeHost, Workspaces, type CodeHost } from './execution/codeHost.js';
import { LocalProcessSandbox } from './execution/sandbox.js';
import { Ledger } from './ledger/ledger.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { CredentialIssuer } from './runtime/credentials.js';
import { ToolGateway } from './runtime/gateway.js';
import { ModelFactory } from './runtime/models.js';

export interface App {
  config: Config;
  ledger: Ledger;
  orchestrator: Orchestrator;
  gateway: ToolGateway;
  workspaces: Workspaces;
  models: ModelFactory;
  close(): Promise<void>;
}

export async function createApp(config: Config, opts: { log?: (m: string) => void; clock?: () => Date } = {}): Promise<App> {
  const url = 'url_env' in config.database ? process.env[config.database.url_env] : undefined;
  if ('url_env' in config.database && !url) throw new Error(`Environment variable ${config.database.url_env} is not set`);
  const ledger = await Ledger.open({ url, localPath: 'local_path' in config.database ? config.database.local_path : undefined,
    policyDir: config.policies_path, clock: opts.clock });
  const host: CodeHost = config.code_hosting.kind === 'local'
    ? new LocalCodeHost(config.code_hosting.path)
    : new GitHubCodeHost(config.code_hosting.repo, config.code_hosting.token_env, config.code_hosting.base_branch);
  await host.ensure();
  const workspaces = new Workspaces(host, path.join(config.storage_path, 'workspaces'));
  const sandbox = new LocalProcessSandbox(config.sandbox.allow_unisolated_local);
  const issuer = CredentialIssuer.fromEnvOrFile(config.credential_secret_env, config.storage_path);
  const gateway = new ToolGateway(ledger, issuer, workspaces, sandbox);
  const models = ModelFactory.fromConfig(config);
  const orchestrator = new Orchestrator({ ledger, gateway, workspaces, sandbox, models, issuer, storageDir: config.storage_path, log: opts.log });
  return {
    config, ledger, orchestrator, gateway, workspaces, models,
    close: async () => { await orchestrator.stop(); await ledger.close(); },
  };
}
