import { ExternalApi, getExternalApiService } from '@nx/graph/shared';
import { getRouter } from './get-router';
import { getProjectGraphService } from './machines/get-services';
import { getGraphService } from './machines/graph.service';

export class ExternalApiImpl extends ExternalApi {
  _projectGraphService = getProjectGraphService();
  _graphIsReady = new Promise<void>((resolve) => {
    this._projectGraphService.subscribe((state) => {
      if (!state.matches('idle')) {
        resolve();
      }
    });
  });
  _graphService = getGraphService();

  router = getRouter();
  externalApiService = getExternalApiService();

  constructor() {
    super();
    this.externalApiService.subscribe(
      ({ type, payload }: { type: string; payload: any }) => {
        if (!this.graphInteractionEventListener) {
          console.log('graphInteractionEventListener not registered.');
          return;
        }
        if (type === 'file-click') {
          const url = `${payload.sourceRoot}/${payload.file}`;
          this.graphInteractionEventListener({
            type: 'file-click',
            payload: { url },
          });
        } else if (type === 'open-project-config') {
          this.graphInteractionEventListener({
            type: 'open-project-config',
            payload,
          });
        } else if (type === 'run-task') {
          this.graphInteractionEventListener({
            type: 'run-task',
            payload,
          });
        } else if (type === 'open-project-graph') {
          this.graphInteractionEventListener({
            type: 'open-project-graph',
            payload,
          });
        } else if (type === 'open-task-graph') {
          this.graphInteractionEventListener({
            type: 'open-task-graph',
            payload,
          });
        } else if (type === 'override-target') {
          this.graphInteractionEventListener({
            type: 'override-target',
            payload,
          });
        } else {
          console.log('unhandled event', type, payload);
        }
      }
    );

    // make sure properties set before are taken into account again
    if (window.externalApi?.loadProjectGraph) {
      this.loadProjectGraph = window.externalApi.loadProjectGraph;
    }
    if (window.externalApi?.loadTaskGraph) {
      this.loadTaskGraph = window.externalApi.loadTaskGraph;
    }
    if (window.externalApi?.loadExpandedTaskInputs) {
      this.loadExpandedTaskInputs = window.externalApi.loadExpandedTaskInputs;
    }
    if (window.externalApi?.loadSourceMaps) {
      this.loadSourceMaps = window.externalApi.loadSourceMaps;
    }
    if (window.externalApi?.graphInteractionEventListener) {
      this.graphInteractionEventListener =
        window.externalApi.graphInteractionEventListener;
    }
  }

  focusProject(projectName: string) {
    this.router.navigate(`/projects/${encodeURIComponent(projectName)}`);
  }

  toggleSelectProject(projectName: string) {
    this._graphIsReady.then(() => {
      const projectSelected = this._projectGraphService
        .getSnapshot()
        .context.selectedProjects.find((p) => p === projectName);
      if (!projectSelected) {
        this._projectGraphService.send({ type: 'selectProject', projectName });
      } else {
        this._projectGraphService.send({
          type: 'deselectProject',
          projectName,
        });
      }
    });
  }

  selectAllProjects() {
    this.router.navigate(`/projects/all`);
  }

  showAffectedProjects() {
    this.router.navigate(`/projects/affected`);
  }

  focusTarget(projectName: string, targetName: string) {
    this.router.navigate(
      `/tasks/${encodeURIComponent(targetName)}?projects=${encodeURIComponent(
        projectName
      )}`
    );
  }

  selectAllTargetsByName(targetName: string) {
    this.router.navigate(`/tasks/${encodeURIComponent(targetName)}/all`);
  }

  enableExperimentalFeatures() {
    localStorage.setItem('showExperimentalFeatures', 'true');
    window.appConfig.showExperimentalFeatures = true;
  }

  disableExperimentalFeatures() {
    localStorage.setItem('showExperimentalFeatures', 'false');
    window.appConfig.showExperimentalFeatures = false;
  }
}
