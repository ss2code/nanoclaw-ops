interface OpsCenterSystemdOptions {
  repoRoot: string;
  nodePath: string;
  tsxPath: string;
  homeDir: string;
}

function safeSystemdValue(name: string, value: string): string {
  if (/\r|\n/.test(value)) throw new Error(`${name} contains a newline`);
  if (!value.startsWith('/')) throw new Error(`${name} must be an absolute path`);
  return value;
}

/** Render a user-level unit without loading the secret-bearing .env file. */
export function buildOpsCenterSystemdUnit(options: OpsCenterSystemdOptions): string {
  const repoRoot = safeSystemdValue('repoRoot', options.repoRoot);
  const nodePath = safeSystemdValue('nodePath', options.nodePath);
  const tsxPath = safeSystemdValue('tsxPath', options.tsxPath);
  const homeDir = safeSystemdValue('homeDir', options.homeDir);

  return `[Unit]
Description=NanoClaw Ops Center
After=network.target docker.service

[Service]
Type=simple
ExecStart=${nodePath} ${tsxPath} ${repoRoot}/ops-center/index.ts
WorkingDirectory=${repoRoot}
Restart=always
RestartSec=5
UMask=0077
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${repoRoot}
RestrictSUIDSGID=true
LockPersonality=true
StandardOutput=append:${repoRoot}/logs/opscenter.log
StandardError=append:${repoRoot}/logs/opscenter.error.log

[Install]
WantedBy=default.target
`;
}
