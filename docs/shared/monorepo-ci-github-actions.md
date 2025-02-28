# Configuring CI Using GitHub Actions and Nx

There are two general approaches to setting up CI with Nx - using a single job or distributing tasks across multiple jobs. For smaller repositories, a single job is faster and cheaper, but once a full CI run starts taking 10 to 15 minutes, using multiple jobs becomes the better option. Nx Cloud's distributed task execution allows you to keep the CI pipeline fast as you scale. As the repository grows, all you need to do is add more agents.

## Process Only Affected Projects With One Job on GitHub Actions

Below is an example of an GitHub Actions setup that runs on a single job, building and testing only what is affected. This uses the [`nx affected` command](/ci/features/affected) to run the tasks only for the projects that were affected by that PR.

```yaml {% fileName=".github/workflows/ci.yml" %}
name: CI
on:
  push:
    branches:
      # Change this if your primary branch is not main
      - main
  pull_request:

# Needed for nx-set-shas when run on the main branch
permissions:
  actions: read
  contents: read

jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # Cache node_modules
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - uses: nrwl/nx-set-shas@v3
      # This line is needed for nx affected to work when CI is running on a PR
      - run: git branch --track main origin/main

      - run: npx nx format:check
      - run: npx nx affected -t lint,test,build --parallel=3
```

### Get the Commit of the Last Successful Build

`GitHub` can track the last successful run on the `main` branch and use this as a reference point for the `BASE`. The `nrwl/nx-set-shas` provides a convenient implementation of this functionality which you can drop into your existing CI config.
To understand why knowing the last successful build is important for the affected command, check out the [in-depth explanation in Actions's docs](https://github.com/marketplace/actions/nx-set-shas#background).

## Distribute Tasks Across Agents on GitHub Actions

To set up [Distributed Task Execution (DTE)](/ci/features/distribute-task-execution), you can run this generator:

```shell
npx nx g ci-workflow --ci=github
```

Or you can copy and paste the workflow below:

```yaml {% fileName=".github/workflows/ci.yml" %}
name: CI
on:
  push:
    branches:
      - main
  pull_request:

# Needed for nx-set-shas when run on the main branch
permissions:
  actions: read
  contents: read

jobs:
  main:
    name: Nx Cloud - Main Job
    uses: nrwl/ci/.github/workflows/nx-cloud-main.yml@v0.13.0
    with:
      number-of-agents: 3
      parallel-commands: |
        npx nx-cloud record -- npx nx format:check
      parallel-commands-on-agents: |
        npx nx affected -t lint,test,build --parallel=2

  agents:
    name: Nx Cloud - Agents
    uses: nrwl/ci/.github/workflows/nx-cloud-agents.yml@v0.13.0
    with:
      number-of-agents: 3
```

This configuration is using two reusable workflows from the `nrwl/ci` repository. You can check out the full [API](https://github.com/nrwl/ci) for those workflows.

The first workflow is for the main job:

```
    uses: nrwl/ci/.github/workflows/nx-cloud-main.yml@v0.13.0
```

The `parallel-commands` script will be run on the main job. The `parallel-commands-on-agents` script will be distributed across the available agents.

The second workflow is for the agents:

```
    uses: nrwl/ci/.github/workflows/nx-cloud-agents.yml@v0.13.0
```

The `number-of-agents` property controls how many agent jobs are created. Note that this property should be the same number for each workflow.

{% callout type="warning" title="Two Types of Parallelization" %}
The `number-of-agents` property and the `--parallel` flag both parallelize tasks, but in different ways. The way this workflow is written, there will be 3 agents running tasks and each agent will try to run 2 tasks at once. If a particular CI run only has 2 tasks, only one agent will be used.
{% /callout %}

## Custom Distributed CI with Nx Cloud on GitHub Actions

Our [reusable GitHub workflow](https://github.com/nrwl/ci) represents a good set of defaults that works for a large number of our users. However, reusable GitHub workflows come with their [limitations](https://docs.github.com/en/actions/using-workflows/reusing-workflows).

If the reusable workflow above doesn't satisfy your needs you should create a custom workflow. If you were to rewrite the reusable workflow yourself, it would look something like this:

```yaml {% fileName=".github/workflows/ci.yml" %}
name: CI
on:
  push:
    branches:
      - main
  pull_request:

# Needed for nx-set-shas when run on the main branch
permissions:
  actions: read
  contents: read

env:
  NX_CLOUD_DISTRIBUTED_EXECUTION: true # this enables DTE
  NX_CLOUD_DISTRIBUTED_EXECUTION_AGENT_COUNT: 3 # expected number of agents
  NX_BRANCH: ${{ github.event.number || github.ref_name }}
  NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX_CLOUD_ACCESS_TOKEN }}
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }} # this is needed if our pipeline publishes to npm

jobs:
  main:
    name: Nx Cloud - Main Job
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        name: Checkout [Pull Request]
        if: ${{ github.event_name == 'pull_request' }}
        with:
          # By default, PRs will be checked-out based on the Merge Commit, but we want the actual branch HEAD.
          ref: ${{ github.event.pull_request.head.sha }}
          # We need to fetch all branches and commits so that Nx affected has a base to compare against.
          fetch-depth: 0

      - uses: actions/checkout@v4
        name: Checkout [Default Branch]
        if: ${{ github.event_name != 'pull_request' }}
        with:
          # We need to fetch all branches and commits so that Nx affected has a base to compare against.
          fetch-depth: 0

      # Set node/npm/yarn versions using volta
      - uses: volta-cli/action@v4
        with:
          package-json-path: '${{ github.workspace }}/package.json'

      - name: Use the package manager cache if available
        uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Check out the default branch
        run: git branch --track main origin/main

      - name: Initialize the Nx Cloud distributed CI run and stop agents when the build tasks are done
        run: npx nx-cloud start-ci-run --stop-agents-after=build

      - name: Run commands in parallel
        run: |
          # initialize an array to store process IDs (PIDs)
          pids=()

          # function to run commands and store the PID
          function run_command() {
            local command=$1
            $command &  # run the command in the background
            pids+=($!)  # store the PID of the background process
          }

          # list of commands to be run on main has env flag NX_CLOUD_DISTRIBUTED_EXECUTION set to false
          run_command "NX_CLOUD_DISTRIBUTED_EXECUTION=false npx nx-cloud record -- npx nx format:check"

          # list of commands to be run on agents
          run_command "npx nx affected -t lint,test,build --parallel=3"

          # wait for all background processes to finish
          for pid in ${pids[*]}; do
            if ! wait $pid; then
              exit 1  # exit with an error status if any process fails
            fi
          done

          exit 0 # exits with success status if a all processes complete successfully

  agents:
    name: Agent ${{ matrix.agent }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        # Add more agents here as your repository expands
        agent: [1, 2, 3]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      # Set node/npm/yarn versions using volta
      - uses: volta-cli/action@v4
        with:
          package-json-path: '${{ github.workspace }}/package.json'

      - name: Use the package manager cache if available
        uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Start Nx Agent ${{ matrix.agent }}
        run: npx nx-cloud start-agent
        env:
          NX_AGENT_NAME: ${{ matrix.agent }}
```

There are comments throughout the workflow to help you understand what is happening in each section.
