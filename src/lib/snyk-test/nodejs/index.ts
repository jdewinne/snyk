import * as baseDebug from 'debug';
const debug = baseDebug('snyk');
import * as request from '../../request';
import * as fs from 'then-fs';
import * as snyk from '../..';
import * as spinner from '../../spinner';
import * as moduleToObject from 'snyk-module';
import * as isCI from '../../is-ci';
import * as _ from 'lodash';
import * as analytics from '../../analytics';
import * as common from '../common';
import * as detect from '../../detect';
import * as nodejsPlugin from '../nodejs-plugin';
import * as depGraphLib from '@snyk/dep-graph';
import {AnnotatedIssue, convertTestDepGraphResultToLegacy} from '../legacy';

// important: this is different from ./config (which is the *user's* config)
import * as snykConfig from '../../config';

export = runTest;

interface Payload {
  method: string;
  url: string;
  json: boolean;
  headers: {
    'x-is-ci': boolean;
    authorization: string;
  };
  body?: {
    depGraph?: depGraphLib.DepGraph,
    policy: string;
    targetFile?: string;
    projectNameOverride?: string;
    hasDevDependencies: boolean;
  };
  qs?: object | null;
  modules?: {
    numDependencies: number;
    pluck: any; // function asisting in traversal of node_modules (snyk-resolve-deps/lib/pluck.js)
  };
}

async function runTest(packageManager: string, root: string, options): Promise<object> {
  options.packageManager = packageManager || detect.detectPackageManager(root, options);
  const spinnerLbl = 'Querying vulnerabilities database...';

  try {
    const payload: Payload = await assemblePayload(root, options);
    const depGraph = payload.body && payload.body.depGraph;
    const payloadPolicy = payload.body && payload.body.policy;
    await spinner(spinnerLbl);
    let res = await sendPayload(payload);

    if (depGraph) {
      res = convertTestDepGraphResultToLegacy(
        res,
        depGraph,
        options.packageManager,
        options.severityThreshold);
    }

    // For Node.js: inject additional information (for remediation etc.) into the response.
    if (payload.modules) {
      res.dependencyCount = payload.modules.numDependencies;
      if (res.vulnerabilities) {
        res.vulnerabilities.forEach((vuln) => {
          if (payload.modules && payload.modules.pluck) {
            const plucked = payload.modules.pluck(vuln.from, vuln.name, vuln.version);
            vuln.__filename = plucked.__filename;
            vuln.shrinkwrap = plucked.shrinkwrap;
            vuln.bundled = plucked.bundled;

            // this is an edgecase when we're testing the directly vuln pkg
            if (vuln.from.length === 1) {
              return;
            }

            const parentPkg = moduleToObject(vuln.from[1]);
            const parent = payload.modules.pluck(vuln.from.slice(0, 2),
              parentPkg.name,
              parentPkg.version);
            vuln.parentDepType = parent.depType;
          }
        });
      }
    }

    analytics.add('vulns-pre-policy', res.vulnerabilities.length);

    res.filesystemPolicy = !!payloadPolicy;
    if (!options['ignore-policy']) {
      res.policy = res.policy || payloadPolicy;
      const policy = await snyk.policy.loadFromText(res.policy);
      res = policy.filter(res, root);
    }
    analytics.add('vulns', res.vulnerabilities.length);

    res.uniqueCount = countUniqueVulns(res.vulnerabilities);

    return res;
  } finally {
    spinner.clear(spinnerLbl)();
  }
}

async function assemblePayload(root: string, options): Promise<Payload> {
  // if the file exists, let's read the package files and post
  // the dependency tree to the server.
  // if it doesn't, then we're assuming this is an existing
  // module on npm, so send the bare argument
  const isLocal = await fs.exists(root);
  analytics.add('local', isLocal);
  if (isLocal) {
    return assembleLocalPayload(root, options);
  }
  return assembleRemotePayload(root, options);
}

function assembleRemotePayload(root: string, options): Payload {
  // options.vulnEndpoint is only used by `snyk protect` (i.e. local filesystem tests)
  const url = `${snykConfig.API}${(options.vulnEndpoint || `/vuln/${options.packageManager}`)}`;
  const module = moduleToObject(root);
  debug('testing remote: %s', module.name + '@' + module.version);

  addPackageAnalytics(module);
  return {
    method: 'GET',
    url: `${url}/${encodeURIComponent(module.name + '@' + module.version)}`,
    qs: common.assembleQueryString(options),
    json: true,
    headers: {
      'x-is-ci': isCI,
      'authorization': 'token ' + snyk.api,
    },
  };
}

async function assembleLocalPayload(root: string, options): Promise<Payload> {
  options.file = options.file || detect.detectPackageFile(root);
  const isLockFileBased = (options.file.endsWith('package-lock.json') || options.file.endsWith('yarn.lock'));
  const getLockFileDeps = isLockFileBased && !options.traverseNodeModules;

  const pkg: any = await nodejsPlugin.inspect(root, options.file, options);

  let policyLocations: string[] = [options['policy-path'] || root];
  policyLocations = policyLocations.concat(pluckPolicies(pkg));
  debug('policies found', policyLocations);

  let policy;
  if (policyLocations.length > 0) {
    try {
      policy = await snyk.policy.load(policyLocations, options);
    } catch (error) {
      // note: inline catch, to handle error from .load
      // the .snyk file wasn't found, which is fine, so we'll return
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  analytics.add('policies', policyLocations.length);
  addPackageAnalytics(pkg);
  if (options.vulnEndpoint) {
    // options.vulnEndpoint is only used by `snyk protect` (i.e. local filesystem tests).
    // It has not been upgraded to use depGraph.
    return {
      method: 'POST',
      url: snykConfig.API + options.vulnEndpoint,
      qs: common.assembleQueryString(options),
      json: true,
      headers: {
        'x-is-ci': isCI,
        'authorization': 'token ' + snyk.api,
      },
      body: {
        ...pkg,
        targetFile: pkg.targetFile || options.file,
        projectNameOverride: options.projectName,
        policy: policy && policy.toString(),
        hasDevDependencies: pkg.hasDevDependencies,
      },
      modules: getLockFileDeps ? undefined : pkg,
    };
  }

  debug('converting dep-tree to dep-graph', {name: pkg.name, targetFile: pkg.targetFile || options.file});
  // Graphs are more compact and robust representations.
  // Legacy parts of the code are still using trees, but will eventually be fully migrated.
  const depGraph = await depGraphLib.legacy.depTreeToGraph(pkg, options.packageManager);
  debug('done converting dep-tree to dep-graph', {uniquePkgsCount: depGraph.getPkgs().length});

  return {
    method: 'POST',
    // The "new" endpoint, accepting dependency graphs.
    // The old one, using dependency trees, is now fully deprecated and is only used
    // by the old versions of the CLI.
    url: snykConfig.API + '/test-dep-graph',
    qs: common.assembleQueryString(options),
    json: true,
    headers: {
      'x-is-ci': isCI,
      'authorization': 'token ' + snyk.api,
    },
    body: {
      depGraph,
      targetFile: pkg.targetFile || options.file,
      projectNameOverride: options.projectName,
      policy: policy && policy.toString(),
      hasDevDependencies: pkg.hasDevDependencies,
    },
    modules: getLockFileDeps ? undefined : pkg,
  };
}

interface Module {
  name: string;
  version: string;
}

function addPackageAnalytics(module: Module): void {
  analytics.add('packageManager', 'npm');
  analytics.add('packageName', module.name);
  analytics.add('packageVersion', module.version);
  analytics.add('package', module.name + '@' + module.version);
}

async function sendPayload(payload: Payload): Promise<any> {
  const hasDevDependencies = payload && payload.body && payload.body.hasDevDependencies;
  const filesystemPolicy = payload.body && !!payload.body.policy;

  // TODO switch to request-native-promise (orsagie)
  return await new Promise((resolve, reject) => {
    request(payload, (error, result, body) => {
      if (error) {
        return reject(error);
      }

      if (result.statusCode !== 200) {
        const err: any = new Error(body && body.error ?
          body.error :
          result.statusCode);

        err.userMessage = body && body.userMessage;
        // this is the case where a local module has been tested, but
        // doesn't have any production deps, but we've noted that they
        // have dep deps, so we'll error with a more useful message
        if (result.statusCode === 404 && hasDevDependencies) {
          err.code = 'NOT_FOUND_HAS_DEV_DEPS';
        } else {
          err.code = result.statusCode;
        }

        if (result.statusCode === 500) {
          debug('Server error', body.stack);
        }

        return reject(err);
      }

      body.filesystemPolicy = filesystemPolicy;

      resolve(body);
    });
  });
}

function countUniqueVulns(vulns: AnnotatedIssue[]): number {
  const seen = {};
  const count = vulns.reduce((acc, curr) => {
    if (!seen[curr.id]) {
      seen[curr.id] = true;
      acc++;
    }
    return acc;
  }, 0);

  return count;
}

function pluckPolicies(pkg) {
  if (!pkg) {
    return null;
  }

  if (pkg.snyk) {
    return pkg.snyk;
  }

  if (!pkg.dependencies) {
    return null;
  }

  return _.flatten(Object.keys(pkg.dependencies).map((name) => {
    return pluckPolicies(pkg.dependencies[name]);
  }).filter(Boolean));
}
