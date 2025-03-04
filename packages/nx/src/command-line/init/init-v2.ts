import { existsSync } from 'fs';
import { PackageJson } from '../../utils/package-json';
import { prerelease } from 'semver';
import { output } from '../../utils/output';
import { getPackageManagerCommand } from '../../utils/package-manager';
import { generateDotNxSetup } from './implementation/dot-nx/add-nx-scripts';
import { runNxSync } from '../../utils/child-process';
import { readJsonFile } from '../../utils/fileutils';
import { nxVersion } from '../../utils/versions';
import {
  addDepsToPackageJson,
  askAboutNxCloud,
  createNxJsonFile,
  runInstall,
  updateGitIgnore,
} from './implementation/utils';
import { prompt } from 'enquirer';
import { execSync } from 'child_process';
import { addNxToAngularCliRepo } from './implementation/angular';
import { globWithWorkspaceContext } from '../../utils/workspace-context';

export interface InitArgs {
  interactive: boolean;
  nxCloud?: boolean;
  useDotNxInstallation?: boolean;
  integrated?: boolean; // For Angular projects only
}

export async function initHandler(options: InitArgs): Promise<void> {
  const version =
    process.env.NX_VERSION ?? (prerelease(nxVersion) ? 'next' : 'latest');
  if (process.env.NX_VERSION) {
    output.log({ title: `Using version ${process.env.NX_VERSION}` });
  }

  if (!existsSync('package.json') || options.useDotNxInstallation) {
    if (process.platform !== 'win32') {
      console.log(
        'Setting Nx up installation in `.nx`. You can run Nx commands like: `./nx --help`'
      );
    } else {
      console.log(
        'Setting Nx up installation in `.nx`. You can run Nx commands like: `./nx.bat --help`'
      );
    }
    generateDotNxSetup(version);
    // invokes the wrapper, thus invoking the initial installation process
    runNxSync('');
    return;
  }

  // TODO(jack): Remove this Angular logic once `@nx/plugin` is compatible with PCv3.
  if (existsSync('angular.json')) {
    await addNxToAngularCliRepo({
      ...options,
      integrated: !!options.integrated,
    });
    return;
  }

  const repoRoot = process.cwd();
  const cacheableOperations: string[] = [];
  createNxJsonFile(repoRoot, [], cacheableOperations, {});

  const pmc = getPackageManagerCommand();

  updateGitIgnore(repoRoot);

  const detectPluginsResponse = await detectPlugins();
  const useNxCloud =
    options.nxCloud ?? (options.interactive ? await askAboutNxCloud() : false);

  if (detectPluginsResponse) {
    addDepsToPackageJson(repoRoot, detectPluginsResponse.plugins);
  }

  output.log({ title: '📦 Installing Nx' });

  runInstall(repoRoot, pmc);

  if (detectPluginsResponse) {
    output.log({ title: '🔨 Configuring plugins' });
    for (const plugin of detectPluginsResponse.plugins) {
      execSync(
        `${pmc.exec} nx g ${plugin}:init --skipPackageJson ${
          detectPluginsResponse.updatePackageScripts
            ? '--updatePackageScripts'
            : ''
        } --no-interactive`,
        {
          stdio: [0, 1, 2],
          cwd: repoRoot,
        }
      );
    }
  }

  if (useNxCloud) {
    output.log({ title: '🛠️ Setting up Nx Cloud' });
    execSync(
      `${pmc.exec} nx g nx:connect-to-nx-cloud --installationSource=nx-init-pcv3 --quiet --no-interactive`,
      {
        stdio: [0, 1, 2],
        cwd: repoRoot,
      }
    );
  }
}

const npmPackageToPluginMap: Record<string, string> = {
  // Generic JS tools
  eslint: '@nx/eslint',
  storybook: '@nx/storybook',
  // Bundlers
  vite: '@nx/vite',
  vitest: '@nx/vite',
  webpack: '@nx/webpack',
  // Testing tools
  jest: '@nx/jest',
  cypress: '@nx/cypress',
  playwright: '@nx/playwright',
  next: '@nx/next',
  nuxt: '@nx/nuxt',
};

async function detectPlugins(): Promise<
  undefined | { plugins: string[]; updatePackageScripts: boolean }
> {
  let files = ['package.json'].concat(
    globWithWorkspaceContext(process.cwd(), ['**/*/package.json'])
  );

  const detectedPlugins = new Set<string>();
  for (const file of files) {
    if (!existsSync(file)) continue;

    let packageJson: PackageJson;
    try {
      packageJson = readJsonFile(file);
    } catch {
      // Could have malformed JSON for unit tests, etc.
      continue;
    }

    const deps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const [dep, plugin] of Object.entries(npmPackageToPluginMap)) {
      if (deps[dep]) {
        detectedPlugins.add(plugin);
      }
    }
  }

  const plugins = Array.from(detectedPlugins);

  if (plugins.length === 0) return undefined;

  output.log({
    title: `Recommended Plugins:`,
    bodyLines: [
      `Add these Nx plugins to integrate with the tools used in your workspace.`,
    ],
  });

  const pluginsToInstall = await prompt<{ plugins: string[] }>([
    {
      name: 'plugins',
      type: 'multiselect',
      message: `Which plugins would you like to add?`,
      choices: plugins.map((p) => ({ name: p, value: p })),
      initial: plugins.map((_, i) => i) as unknown as number, // casting to avoid type error due to bad d.ts file from enquirer
    },
  ]).then((r) => r.plugins);

  if (pluginsToInstall?.length === 0) return undefined;

  const updatePackageScripts = await prompt<{ updatePackageScripts: string }>([
    {
      name: 'updatePackageScripts',
      type: 'autocomplete',
      message: `Do you want to start using Nx in your package.json scripts?`,
      choices: [
        {
          name: 'Yes',
        },
        {
          name: 'No',
        },
      ],
      initial: 'Yes' as any,
    },
  ]).then((r) => r.updatePackageScripts === 'Yes');

  return {
    plugins: pluginsToInstall,
    updatePackageScripts,
  };
}
