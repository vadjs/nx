import { CreateNodesContext } from '@nx/devkit';
import { createNodes } from './plugin';

jest.mock('vite', () => ({
  loadConfigFromFile: jest.fn().mockImplementation(() => {
    return Promise.resolve({
      path: 'vitest.config.ts',
      config: {},
      dependencies: [],
    });
  }),
}));

jest.mock('../utils/executor-utils', () => ({
  loadViteDynamicImport: jest.fn().mockResolvedValue({
    loadConfigFromFile: jest.fn().mockResolvedValue({
      path: 'vitest.config.ts',
      config: {},
      dependencies: [],
    }),
  }),
}));

describe('@nx/vite/plugin', () => {
  let createNodesFunction = createNodes[1];
  let context: CreateNodesContext;
  describe('root project', () => {
    beforeEach(async () => {
      context = {
        nxJsonConfiguration: {
          targetDefaults: {},
          namedInputs: {
            default: ['{projectRoot}/**/*'],
            production: ['!{projectRoot}/**/*.spec.ts'],
          },
        },
        workspaceRoot: '',
      };
    });

    afterEach(() => {
      jest.resetModules();
    });

    it('should create nodes', async () => {
      const nodes = await createNodesFunction(
        'vitest.config.ts',
        {
          testTargetName: 'test',
        },
        context
      );

      expect(nodes).toMatchSnapshot();
    });
  });
});
