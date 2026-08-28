// Delivery for the ChemClaw3 frontend: build the image, prove it serves, publish it by digest,
// and roll it out.
//
// `.github/workflows/ci.yml` is the gate and stays the gate — typecheck, lint, format, unit tests,
// contrast, the bundle-shape checks, Playwright, and a container job that builds the image and
// exercises it. What it cannot do is push anywhere or reach a cluster. That is this file.
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
        sh """
          rm -rf .jenkins-lib
          git clone --depth 1 --branch '${params.CHEMCLAW3_BRANCH}' --filter=blob:none --sparse \
            '${params.CHEMCLAW3_REPO}' .jenkins-lib
          cd .jenkins-lib && git sparse-checkout set deploy/jenkins/lib
        """
      }
    }

    stage('Gate') {
      when { expression { params.RUN_GATE } }
      steps {
        sh 'npm ci'
        sh 'npm run typecheck'
        sh 'npm run lint'
        sh 'npm run format:check'
        sh 'npm test'
        sh 'npm run build'
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

    // The container serves the SPA, its runtime config and nothing it should not. Same four
    // assertions the GitHub container job makes, made here of the artifact that is about to be
    // published — the proxy whitelist one especially, since it is the only thing standing between
    // the browser and every backend route the BFF could otherwise forward. Same kaniko carve-out
    // as the stage above, for the same reason.
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

          for _ in $(seq 1 30); do
            curl -sf http://127.0.0.1:8080/healthz >/dev/null && break || sleep 1
          done
          curl -sf http://127.0.0.1:8080/healthz | grep -q '"ok"'
          # One image, any tenant: config is rendered from the environment at request time.
          curl -sf http://127.0.0.1:8080/config.js | grep -q '__CHEMCLAW_CONFIG__'
          # SPA fallback, so a deep link or the MSAL redirect URI resolves.
          test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/auth/callback)" = 200
          # The proxy whitelist must refuse a service route the UI never calls.
          test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/metrics)" = 404
          echo "the image serves the app, its config, the SPA fallback, and blocks un-whitelisted routes"
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
