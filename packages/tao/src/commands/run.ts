import * as minimist from 'minimist';
import {
  combineOptionsForExecutor,
  convertToCamelCase,
  handleErrors,
  Options,
  Schema,
} from '../shared/params';
import { printHelp } from '../shared/print-help';
import {
  TargetConfiguration,
  WorkspaceConfiguration,
  Workspaces,
} from '../shared/workspace';

import * as chalk from 'chalk';
import { logger } from '../shared/logger';
import { eachValueFrom } from 'rxjs-for-await';

export interface RunOptions {
  project: string;
  target: string;
  configuration: string;
  help: boolean;
  runOptions: Options;
}

function throwInvalidInvocation() {
  throw new Error(
    `Specify the project name and the target (e.g., nx run proj:build)`
  );
}

function parseRunOpts(
  cwd: string,
  args: string[],
  defaultProjectName: string | null
): RunOptions {
  const runOptions = convertToCamelCase(
    minimist(args, {
      boolean: ['help', 'prod'],
      string: ['configuration', 'project'],
      alias: {
        c: 'configuration',
      },
    })
  );
  const help = runOptions.help as boolean;
  if (!runOptions._ || !runOptions._[0]) {
    throwInvalidInvocation();
  }
  // eslint-disable-next-line prefer-const
  let [project, target, configuration]: [
    string,
    string,
    string
  ] = runOptions._[0].split(':');
  if (!project && defaultProjectName) {
    logger.debug(
      `No project name specified. Using default project : ${chalk.bold(
        defaultProjectName
      )}`
    );
    project = defaultProjectName;
  }
  if (runOptions.configuration) {
    configuration = runOptions.configuration as string;
  }
  if (runOptions.prod) {
    configuration = 'production';
  }
  if (runOptions.project) {
    project = runOptions.project as string;
  }
  if (!project || !target) {
    throwInvalidInvocation();
  }
  const res = { project, target, configuration, help, runOptions };
  delete runOptions['help'];
  delete runOptions['_'];
  delete runOptions['c'];
  delete runOptions['configuration'];
  delete runOptions['prod'];
  delete runOptions['project'];

  return res;
}

export function printRunHelp(opts: RunOptions, schema: Schema) {
  printHelp(`nx run ${opts.project}:${opts.target}`, schema);
}

export function validateTargetAndConfiguration(
  workspace: WorkspaceConfiguration,
  opts: RunOptions
) {
  const project = workspace.projects[opts.project];
  if (!project) {
    throw new Error(`Could not find project "${opts.project}"`);
  }
  const target = project.targets[opts.target];
  const availableTargets = Object.keys(project.targets);
  if (!target) {
    throw new Error(
      `Could not find target "${opts.target}" in the ${
        opts.project
      } project. Valid targets are: ${chalk.bold(availableTargets.join(', '))}`
    );
  }

  // Not all targets have configurations
  // and an undefined configuration is valid
  if (opts.configuration) {
    if (target.configurations) {
      const configuration = target.configurations[opts.configuration];
      if (!configuration) {
        throw new Error(
          `Could not find configuration "${opts.configuration}" in ${
            opts.project
          }:${opts.target}. Valid configurations are: ${Object.keys(
            target.configurations
          ).join(', ')}`
        );
      }
    } else {
      throw new Error(
        `No configurations are defined for ${opts.project}:${opts.target}, so "${opts.configuration}" is invalid.`
      );
    }
  }
}

export interface TargetContext {
  root: string;
  target: TargetConfiguration;
  workspace: WorkspaceConfiguration;
  projectName: string;
}

function isPromise(
  v: Promise<{ success: boolean }> | AsyncIterableIterator<{ success: boolean }>
): v is Promise<{ success: boolean }> {
  return typeof (v as any).then === 'function';
}

async function iteratorToProcessStatusCode(
  i: AsyncIterableIterator<{ success: boolean }>
): Promise<number> {
  let r;
  for await (r of i) {
  }
  return r.success ? 0 : 1;
}

export async function run(
  cwd: string,
  root: string,
  args: string[],
  isVerbose: boolean
) {
  const ws = new Workspaces(root);

  return handleErrors(isVerbose, async () => {
    const workspace = ws.readWorkspaceConfiguration();
    const defaultProjectName = ws.calculateDefaultProjectName(cwd, workspace);
    const opts = parseRunOpts(cwd, args, defaultProjectName);
    validateTargetAndConfiguration(workspace, opts);

    const target = workspace.projects[opts.project].targets[opts.target];
    const [nodeModule, executor] = target.executor.split(':');
    const { schema, implementation } = ws.readExecutor(nodeModule, executor);
    const combinedOptions = combineOptionsForExecutor(
      opts.runOptions,
      opts.configuration,
      target,
      schema,
      defaultProjectName,
      ws.relativeCwd(cwd)
    );
    if (opts.help) {
      printRunHelp(opts, schema);
      return 0;
    }

    if (ws.isNxExecutor(nodeModule, executor)) {
      const r = implementation(combinedOptions, {
        root,
        target,
        workspace,
        projectName: opts.project,
      });
      if (isPromise(r)) {
        return (await r).success ? 0 : 1;
      } else {
        return iteratorToProcessStatusCode(r);
      }
    } else {
      return iteratorToProcessStatusCode(
        eachValueFrom(
          await (await import('./ngcli-adapter')).scheduleTarget(
            root,
            {
              ...opts,
              runOptions: combinedOptions,
            },
            isVerbose
          )
        )
      );
    }
  });
}
