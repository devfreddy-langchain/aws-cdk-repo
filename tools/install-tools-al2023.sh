#!/bin/bash
# =============================================================================
# install-tools-al2023.sh — the CLIs the post-deploy scripts need, on Amazon Linux 2023 (x86_64)
#
# The bastion this app creates (lib/components/bastion.ts) runs this file as its EC2 user data,
# so it already has the tools (log: /var/log/langsmith-tools.log). On another Amazon Linux 2023
# host inside the VPC:
#   sudo bash tools/install-tools-al2023.sh
# kubectl follows EKS_VERSION (keep it within one minor version of eks.version in your config).
#
# Installs: jq, envsubst (gettext), openssl, git, tar  (dnf)
#           kubectl  matching EKS_VERSION        (dl.k8s.io, sha256 verified)
#           helm     HELM_VERSION                (get.helm.sh, sha256 verified)
#           yq       YQ_VERSION (mikefarah v4)   (github.com, sha256 verified)
#           crane    CRANE_VERSION               (github.com, sha256 verified; only
#                                                 needed on the host that mirrors images)
# AWS CLI v2 is preinstalled on Amazon Linux 2023.
# Needs outbound HTTPS to: the AL2023 package repos (via the S3 gateway endpoint or
# NAT), dl.k8s.io, get.helm.sh, github.com and objects.githubusercontent.com.
# =============================================================================
set -euo pipefail
exec > >(tee -a /var/log/langsmith-tools.log) 2>&1

EKS_VERSION=${EKS_VERSION:-1.34}
HELM_VERSION=${HELM_VERSION:-v3.19.0}
YQ_VERSION=${YQ_VERSION:-v4.47.2}
CRANE_VERSION=${CRANE_VERSION:-v0.22.1}
cd /tmp

dnf -y install jq gettext openssl git tar gzip

# kubectl: newest patch of the cluster's minor version
KVER=$(curl -fsSL "https://dl.k8s.io/release/stable-${EKS_VERSION}.txt")
curl -fsSLo kubectl "https://dl.k8s.io/release/${KVER}/bin/linux/amd64/kubectl"
echo "$(curl -fsSL "https://dl.k8s.io/release/${KVER}/bin/linux/amd64/kubectl.sha256")  kubectl" | sha256sum -c -
install -m 0755 kubectl /usr/local/bin/kubectl

# helm
curl -fsSLo helm.tgz "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz"
echo "$(curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz.sha256")  helm.tgz" | sha256sum -c -
tar -xzf helm.tgz && install -m 0755 linux-amd64/helm /usr/local/bin/helm

# yq (mikefarah)
curl -fsSLo yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"
curl -fsSLo yq.sums "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/checksums-bsd"
grep "(yq_linux_amd64)" yq.sums | grep -q "$(sha256sum yq | cut -d' ' -f1)"
install -m 0755 yq /usr/local/bin/yq

# crane (go-containerregistry)
curl -fsSLo crane.tgz "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
curl -fsSLo crane.sums "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/checksums.txt"
grep " go-containerregistry_Linux_x86_64.tar.gz$" crane.sums | sed 's/go-containerregistry_Linux_x86_64.tar.gz/crane.tgz/' | sha256sum -c -
tar -xzf crane.tgz crane && install -m 0755 crane /usr/local/bin/crane

aws --version; kubectl version --client; helm version --short; yq --version; crane version; jq --version
echo "tools installed"
