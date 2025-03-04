import {
  addDependenciesToPackageJson,
  createProjectGraphAsync,
  GeneratorCallback,
  readNxJson,
  readProjectConfiguration,
  removeDependenciesFromPackageJson,
  runTasksInSerial,
  stripIndents,
  TargetConfiguration,
  Tree,
  updateJson,
  updateNxJson,
  updateProjectConfiguration,
} from '@nx/devkit';
import { initGenerator as jsInitGenerator } from '@nx/js';

import { findRootJestConfig } from '../../utils/config/find-root-jest-files';
import {
  babelJestVersion,
  jestTypesVersion,
  jestVersion,
  nxVersion,
  swcJestVersion,
  tsJestVersion,
  tslibVersion,
  tsNodeVersion,
  typesNodeVersion,
} from '../../utils/versions';
import { JestInitSchema } from './schema';
import { readTargetDefaultsForTarget } from 'nx/src/project-graph/utils/project-configuration-utils';

interface NormalizedSchema extends ReturnType<typeof normalizeOptions> {}

const schemaDefaults = {
  compiler: 'tsc',
  js: false,
  rootProject: false,
  testEnvironment: 'jsdom',
} as const;

function generateGlobalConfig(tree: Tree, isJS: boolean) {
  const contents = isJS
    ? stripIndents`
    const { getJestProjects } = require('@nx/jest');

    module.exports = {
      projects: getJestProjects()
    };`
    : stripIndents`
    import { getJestProjects } from '@nx/jest';

    export default {
     projects: getJestProjects()
    };`;
  tree.write(`jest.config.${isJS ? 'js' : 'ts'}`, contents);
}

function addPlugin(tree: Tree) {
  const nxJson = readNxJson(tree);

  nxJson.plugins ??= [];
  if (
    !nxJson.plugins.some((p) =>
      typeof p === 'string'
        ? p === '@nx/jest/plugin'
        : p.plugin === '@nx/jest/plugin'
    )
  ) {
    nxJson.plugins.push({
      plugin: '@nx/jest/plugin',
      options: {
        targetName: 'test',
      },
    });
  }
  updateNxJson(tree, nxJson);
}

async function createJestConfig(tree: Tree, options: NormalizedSchema) {
  if (!tree.exists('jest.preset.js')) {
    // preset is always js file.
    tree.write(
      `jest.preset.js`,
      `
      const nxPreset = require('@nx/jest/preset').default;

      module.exports = { ...nxPreset }`
    );

    const shouldAddPlugin = process.env.NX_PCV3 === 'true';
    if (shouldAddPlugin) {
      addPlugin(tree);
    }

    updateProductionFileSet(tree);
    if (!shouldAddPlugin) {
      addJestTargetDefaults(tree, shouldAddPlugin);
    }
  }
  if (options.rootProject) {
    // we don't want any config to be made because the `configurationGenerator` will do it.
    // will copy the template config file
    return;
  }
  const rootJestPath = findRootJestConfig(tree);
  if (!rootJestPath) {
    // if there's not root jest config, we will create one and return
    // this can happen when:
    // - root jest config was renamed => in which case there is migration needed
    // - root project didn't have jest setup => again, no migration is needed
    generateGlobalConfig(tree, options.js);
    return;
  }

  if (tree.exists(rootJestPath)) {
    // moving from root project config to monorepo-style config
    const { nodes: projects } = await createProjectGraphAsync();
    const projectConfigurations = Object.values(projects);
    const rootProject = projectConfigurations.find(
      (projectNode) => projectNode.data?.root === '.'
    );
    // root project might have been removed,
    // if it's missing there's nothing to migrate
    if (rootProject) {
      const jestTarget = Object.entries(rootProject.data?.targets ?? {}).find(
        ([_, t]) =>
          ((t?.executor === '@nx/jest:jest' ||
            t?.executor === '@nrwl/jest:jest') &&
            t?.options?.jestConfig === rootJestPath) ||
          (t?.executor === 'nx:run-commands' && t?.options?.command === 'jest')
      );
      if (!jestTarget) {
        return;
      }

      const [jestTargetName, jestTargetConfigInGraph] = jestTarget;
      // if root project doesn't have jest target, there's nothing to migrate
      const rootProjectConfig = readProjectConfiguration(
        tree,
        rootProject.name
      );

      if (
        rootProjectConfig.targets['test']?.executor === 'nx:run-commands'
          ? rootProjectConfig.targets['test']?.command !== 'jest'
          : rootProjectConfig.targets['test']?.options?.jestConfig !==
            rootJestPath
      ) {
        // Jest target has already been updated
        return;
      }

      const jestProjectConfig = `jest.config.${
        rootProjectConfig.projectType === 'application' ? 'app' : 'lib'
      }.${options.js ? 'js' : 'ts'}`;

      tree.rename(rootJestPath, jestProjectConfig);

      const nxJson = readNxJson(tree);
      const targetDefaults = readTargetDefaultsForTarget(
        jestTargetName,
        nxJson.targetDefaults,
        jestTargetConfigInGraph.executor
      );

      const target: TargetConfiguration = (rootProjectConfig.targets[
        jestTargetName
      ] ??=
        jestTargetConfigInGraph.executor === 'nx:run-commands'
          ? { command: `jest --config ${jestProjectConfig}` }
          : {
              executor: jestTargetConfigInGraph.executor,
              options: {},
            });

      if (target.executor === '@nx/jest:jest') {
        target.options.jestConfig = jestProjectConfig;
      }

      if (targetDefaults?.cache === undefined) {
        target.cache = jestTargetConfigInGraph.cache;
      }
      if (targetDefaults?.inputs === undefined) {
        target.inputs = jestTargetConfigInGraph.inputs;
      }
      if (targetDefaults?.outputs === undefined) {
        target.outputs = jestTargetConfigInGraph.outputs;
      }
      if (targetDefaults?.dependsOn === undefined) {
        target.dependsOn = jestTargetConfigInGraph.dependsOn;
      }

      updateProjectConfiguration(tree, rootProject.name, rootProjectConfig);
      // generate new global config as it was move to project config or is missing
      generateGlobalConfig(tree, options.js);
    }
  }
}

function updateProductionFileSet(tree: Tree) {
  const nxJson = readNxJson(tree);

  const productionFileSet = nxJson.namedInputs?.production;
  if (productionFileSet) {
    // This is one of the patterns in the default jest patterns
    productionFileSet.push(
      // Remove spec, test, and snapshots from the production fileset
      '!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)',
      // Remove tsconfig.spec.json
      '!{projectRoot}/tsconfig.spec.json',
      // Remove jest.config.js/ts
      '!{projectRoot}/jest.config.[jt]s',
      // Remove test-setup.js/ts
      // TODO(meeroslav) this should be standardized
      '!{projectRoot}/src/test-setup.[jt]s',
      '!{projectRoot}/test-setup.[jt]s'
    );
    // Dedupe and set
    nxJson.namedInputs.production = Array.from(new Set(productionFileSet));
  }

  updateNxJson(tree, nxJson);
}

function addJestTargetDefaults(tree: Tree, hasPlugin: boolean) {
  const nxJson = readNxJson(tree);

  nxJson.targetDefaults ??= {};
  nxJson.targetDefaults['@nx/jest:jest'] ??= {};

  if (!hasPlugin) {
    const productionFileSet = nxJson.namedInputs?.production;

    nxJson.targetDefaults['@nx/jest:jest'].cache ??= true;
    // Test targets depend on all their project's sources + production sources of dependencies
    nxJson.targetDefaults['@nx/jest:jest'].inputs ??= [
      'default',
      productionFileSet ? '^production' : '^default',
      '{workspaceRoot}/jest.preset.js',
    ];
  }

  nxJson.targetDefaults['@nx/jest:jest'].options ??= {
    passWithNoTests: true,
  };
  nxJson.targetDefaults['@nx/jest:jest'].configurations ??= {
    ci: {
      ci: true,
      codeCoverage: true,
    },
  };

  updateNxJson(tree, nxJson);
}

function updateDependencies(tree: Tree, options: NormalizedSchema) {
  const dependencies = {
    tslib: tslibVersion,
  };
  const devDeps = {
    '@nx/jest': nxVersion,
    jest: jestVersion,

    // because the default jest-preset uses ts-jest,
    // jest will throw an error if it's not installed
    // even if not using it in overriding transformers
    'ts-jest': tsJestVersion,
  };

  if (options.testEnvironment !== 'none') {
    devDeps[`jest-environment-${options.testEnvironment}`] = jestVersion;
  }

  if (!options.js) {
    devDeps['ts-node'] = tsNodeVersion;
    devDeps['@types/jest'] = jestTypesVersion;
    devDeps['@types/node'] = typesNodeVersion;
  }

  if (options.compiler === 'babel' || options.babelJest) {
    devDeps['babel-jest'] = babelJestVersion;
    // in some cases @nx/js will not already be present i.e. node only projects
    devDeps['@nx/js'] = nxVersion;
  } else if (options.compiler === 'swc') {
    devDeps['@swc/jest'] = swcJestVersion;
  }

  return addDependenciesToPackageJson(tree, dependencies, devDeps);
}

function updateExtensions(host: Tree) {
  if (!host.exists('.vscode/extensions.json')) {
    return;
  }

  updateJson(host, '.vscode/extensions.json', (json) => {
    json.recommendations = json.recommendations || [];
    const extension = 'firsttris.vscode-jest-runner';
    if (!json.recommendations.includes(extension)) {
      json.recommendations.push(extension);
    }
    return json;
  });
}

export async function jestInitGenerator(
  tree: Tree,
  schema: JestInitSchema
): Promise<GeneratorCallback> {
  const options = normalizeOptions(schema);
  const tasks: GeneratorCallback[] = [];

  tasks.push(
    await jsInitGenerator(tree, {
      ...schema,
      skipFormat: true,
    })
  );

  await createJestConfig(tree, options);

  if (!options.skipPackageJson) {
    removeDependenciesFromPackageJson(tree, ['@nx/jest'], []);
    const installTask = updateDependencies(tree, options);
    tasks.push(installTask);
  }

  updateExtensions(tree);
  return runTasksInSerial(...tasks);
}

function normalizeOptions(options: JestInitSchema) {
  return {
    ...schemaDefaults,
    ...options,
  };
}

export default jestInitGenerator;
