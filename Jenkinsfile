// Delivery for the ChemClaw3 frontend: build the image, prove it serves, publish it by digest,
// and roll it out.
//
// `npm run ci` is the gate and stays the gate, and `.github/workflows/ci.yml` is where it runs on
// every push. What a pipeline cannot do is push anywhere or reach a cluster. That is this file.
//
// Neither file describes the gate any more. Both call `scripts/ci.mjs`, which is the single
// definition, and the serving assertions below are `scripts/check-serving.mjs` — also called from
// the GitHub container job. `tests/gate.test.ts` fails if either pipeline grows an assertion of
// its own again.
//
// One thing here is *stronger* than the GitHub job rather than a copy of it: the dev-auth assertion
// runs against the **published image's** bundle rather than the workspace's `dist/`. Those are
// different artifacts — the image is built by the Dockerfile's own `npm run build` with
// `ALLOW_DEV_AUTH` defaulting to false — and the one that matters is the one that ships. A bundle
// carrying the no-token dev provider hands out unauthenticated sessions.
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '30'))
    timeout(time: 60, unit: 'MINUTES')
  }

  parameters {
    string(name: 'IMAGE_REGISTRY', defaultValue: '',
           description: 'Registry and org, e.g. image-registry.openshift-image-registry.svc:5000/chemclaw. Empty = build and verify only.')
    string(name: 'IMAGE_NAME', defaultValue: 'chemclaw3-ui', description: 'Image name within the registry.')
    choice(name: 'IMAGE_BUILDER', choices: ['autodetect', 'buildah', 'podman', 'kaniko', 'docker'],
           description: 'How to build. OpenShift agents get no Docker socket.')
    choice(name: 'DEPLOY_TARGET', choices: ['none', 'openshift'],
           description: 'Where to apply. The UI is a web server; it has no Databricks half.')
    string(name: 'NAMESPACE', defaultValue: '', description: 'Target namespace.')
    string(name: 'DEPLOYMENT', defaultValue: 'chemclaw3-ui', description: 'Deployment to re-point. This repository ships no chart — see README.')
    booleanParam(name: 'DRY_RUN', defaultValue: true, description: 'Build and verify without publishing or deploying. Default true, deliberately.')
    booleanParam(name: 'RUN_GATE', defaultValue: false, description: 'Run the npm gate here too. Off because GitHub Actions is the gate.')
    string(name: 'REGISTRY_CREDENTIALS_ID', defaultValue: 'chemclaw-registry', description: 'Jenkins username/password credential for the registry.')
    string(name: 'CLUSTER_CREDENTIALS_ID', defaultValue: 'chemclaw-openshift', description: 'Jenkins secret-text credential holding the cluster API token.')
    string(name: 'CLUSTER_API', defaultValue: '', description: 'Cluster API URL.')
    string(name: 'CHEMCLAW3_REPO', defaultValue: 'https://github.com/8fqycwdt8v-oss/Chemclaw3.git',
           description: 'Where the shared build/publish library lives (deploy/jenkins/lib).')
    string(name: 'CHEMCLAW3_BRANCH', defaultValue: 'main', description: 'Branch to take that library from.')
  }

  environment {
    IMAGE_BUILDER = "${params.IMAGE_BUILDER == 'autodetect' ? '' : params.IMAGE_BUILDER}"
  }

  stages {
    stage('Preflight') {
      steps {
        script {
          env.REVISION = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
          env.IMAGE_REF = "${params.IMAGE_REGISTRY ? params.IMAGE_REGISTRY + '/' : ''}${params.IMAGE_NAME}:${env.REVISION.take(12)}"
          echo "revision ${env.REVISION}\nimage    ${env.IMAGE_REF}"
        }
        // Four sparse paths, and only the first is for the build. The other three are what
        // `tests/backendContract.test.ts` reads out of this checkout when the Gate stage below
        // runs it: `api/` for the routes, the SSE models and `ErrorCode`, `core/` for
        // `RefusalReason` and `agent/` for `AnswerCheck`. Directories rather than the three files,
        // because `git clone --sparse` initialises **cone** mode and cone mode refuses a file path
        // outright ("is not a directory; to treat it as a directory anyway, rerun with
        // --skip-checks") — driven against a real clone before this was written.
        sh """
          rm -rf .jenkins-lib
          git clone --depth 1 --branch '${params.CHEMCLAW3_BRANCH}' --filter=blob:none --sparse \
            '${params.CHEMCLAW3_REPO}' .jenkins-lib
          cd .jenkins-lib && git sparse-checkout set deploy/jenkins/lib \
            src/chemclaw/api src/chemclaw/core src/chemclaw/agent
        """
      }
    }

    // `npm run ci` is the whole gate — the same one `.github/workflows/ci.yml` runs, because it is
    // the same file (`scripts/ci.mjs`). This stage used to list six commands of its own and was
    // therefore a second, narrower gate: no `npm audit`, no contrast check, no browser suite. Two
    // gates over one repository drift, and the quieter one silently becomes what the bar is.
    //
    // Still off by default: GitHub Actions is the gate, and this pipeline's job is to build,
    // verify and ship the image. What changed is that turning it on now runs the real thing.
    stage('Gate') {
      when { expression { params.RUN_GATE } }
      // The cross-repository contract check reads a Chemclaw3 checkout, and this lane already has
      // one: Preflight clones that repository unconditionally, with whatever credential that needs
      // already in place. So what stood between this gate and the check was a path and a variable,
      // not a credential decision — `ISSUES.md` Issue 14 said otherwise and was falsified by the
      // file it sits beside. REQUIRED rather than best-effort, because a check that degrades to a
      // warning when the checkout moves is a control this stage would claim and not have.
      environment {
        CHEMCLAW3_DIR = "${env.WORKSPACE}/.jenkins-lib"
        CHEMCLAW3_REQUIRED = '1'
      }
      steps {
        sh 'npm ci'
        // Provisioning a browser is an agent concern, not an assertion — the same split
        // `.github/workflows/ci.yml` makes. Without `--with-deps`, which needs root.
        sh 'npx playwright install chromium'
        sh 'npm run ci'
      }
    }

    stage('Build the image') {
      steps {
        script {
          if (params.DRY_RUN || !params.IMAGE_REGISTRY) {
            sh """
              set -euo pipefail
              . .jenkins-lib/deploy/jenkins/lib/image.sh
              builder="\$(detect_builder)"
              "\${builder}" build -t '${env.IMAGE_REF}' .
            """
          } else {
            withCredentials([usernamePassword(credentialsId: params.REGISTRY_CREDENTIALS_ID,
                                              usernameVariable: 'REGISTRY_USER', passwordVariable: 'REGISTRY_PASSWORD')]) {
              env.IMAGE_DIGEST = sh(returnStdout: true, script: """
                set -euo pipefail
                . .jenkins-lib/deploy/jenkins/lib/registry-login.sh
                . .jenkins-lib/deploy/jenkins/lib/image.sh
                registry_login '${params.IMAGE_REGISTRY}'
                build_and_push Dockerfile . '${env.IMAGE_REF}'
              """).trim()
            }
          }
        }
      }
    }

    // Against the image, not the workspace. `npm run check:no-dev-auth` in the GitHub job reads the
    // `dist/` this agent built; the image's bundle was built inside the Dockerfile, with
    // `ALLOW_DEV_AUTH` defaulting to false. Only one of those two artifacts is served to a chemist.
    //
    // kaniko builds and pushes in one pass and leaves no local image (see `image.sh`'s
    // `build_and_push`) — but when it actually pushed one (a real, non-dry-run build with a
    // registry set), `IMAGE_REF` names a real image sitting in that registry, and this pulls it
    // back explicitly rather than silently skipping the one check that inspects the artifact that
    // actually ships. Only the combination that produced nothing anywhere — kaniko with no
    // registry push — is still skipped, and that combination is also the one the Deploy stage
    // below already refuses to act on.
    stage('The published bundle carries no dev auth provider') {
      when { expression { params.IMAGE_BUILDER != 'kaniko' || (!params.DRY_RUN && params.IMAGE_REGISTRY) } }
      steps {
        sh '''
          set -euo pipefail
          runner="$(command -v podman || command -v docker)"
          rm -rf .image-dist && mkdir -p .image-dist
          if [ "${IMAGE_BUILDER:-}" = "kaniko" ]; then
            "${runner}" pull "${IMAGE_REF}"
          fi
          cid="$("${runner}" create "${IMAGE_REF}")"
          trap '"${runner}" rm -f "${cid}" >/dev/null 2>&1 || true' EXIT
          "${runner}" cp "${cid}:/app/dist/client" .image-dist/client
          CLIENT_DIR=.image-dist/client ALLOW_DEV_AUTH=false node scripts/assert-no-dev-auth.mjs
        '''
      }
    }

    // The container serves the SPA, its runtime config and nothing it should not. Literally the
    // same four assertions the GitHub container job makes — `scripts/check-serving.mjs`, one file,
    // called from both — made here of the artifact that is about to be published. They used to be
    // a hand-written copy of that job's `curl`s, which is two assertions rather than one, and the
    // proxy-whitelist one especially is worth not having a second edition of: it is the only thing
    // standing between the browser and every backend route the BFF could otherwise forward.
    //
    // How the image got here still differs and should — buildah, podman or kaniko, possibly pulled
    // back out of a registry. What it must serve does not. Same kaniko carve-out as the stage
    // above, for the same reason.
    stage('The image serves') {
      when { expression { params.IMAGE_BUILDER != 'kaniko' || (!params.DRY_RUN && params.IMAGE_REGISTRY) } }
      steps {
        sh '''
          set -euo pipefail
          runner="$(command -v podman || command -v docker)"
          if [ "${IMAGE_BUILDER:-}" = "kaniko" ]; then
            "${runner}" pull "${IMAGE_REF}"
          fi
          cid="$("${runner}" run -d -p 127.0.0.1:8080:8080 \
            -e AUTH_MODE=dev -e ALLOW_INSECURE_AUTH=true \
            -e CHEMCLAW_API_URL=http://127.0.0.1:9 "${IMAGE_REF}")"
          trap '"${runner}" logs "${cid}"; "${runner}" rm -f "${cid}" >/dev/null 2>&1 || true' EXIT

          node scripts/check-serving.mjs http://127.0.0.1:8080
        '''
      }
    }

    stage('Deploy') {
      when { expression { params.DEPLOY_TARGET == 'openshift' && !params.DRY_RUN } }
      steps {
        script {
          if (!env.IMAGE_DIGEST?.startsWith('sha256:')) {
            error 'refusing to deploy without the digest the registry assigned — a tag is a pointer.'
          }
          withCredentials([string(credentialsId: params.CLUSTER_CREDENTIALS_ID, variable: 'CLUSTER_TOKEN')]) {
            sh """
              set -euo pipefail
              oc login --token="\${CLUSTER_TOKEN}" --server='${params.CLUSTER_API}' >/dev/null
              oc set image 'deployment/${params.DEPLOYMENT}' \
                'ui=${params.IMAGE_REGISTRY}/${params.IMAGE_NAME}@${env.IMAGE_DIGEST}' \
                --namespace '${params.NAMESPACE}'
              oc rollout status 'deployment/${params.DEPLOYMENT}' --namespace '${params.NAMESPACE}' --timeout=10m
            """
          }
        }
      }
    }

    stage('Report the digest') {
      when { expression { !params.DRY_RUN && params.IMAGE_REGISTRY != '' } }
      steps {
        script {
          writeFile file: 'ui-digest.txt', text: "${env.IMAGE_DIGEST}\n"
          archiveArtifacts artifacts: 'ui-digest.txt', fingerprint: true
          echo "UI_DIGEST for the Chemclaw3 release job: ${env.IMAGE_DIGEST}"
        }
      }
    }
  }

  post { always { sh 'rm -rf .jenkins-lib .image-dist' } }
}
