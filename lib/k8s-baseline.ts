import * as fs from 'fs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as yaml from 'js-yaml';
import * as genPolicy from './policies/policies';

type k8sBaselineProps = cdk.StackProps & {
  eksCluster: eks.Cluster;
  eksKms: kms.Key;
};

export class EKSk8sBaseline extends cdk.Stack {
  constructor(scope: Construct, id: string, props: k8sBaselineProps) {
    super(scope, id, props);
    // ============================================================================================================================================
    // Resource Creation
    // ============================================================================================================================================
    /*
    Service Account Resources will be created in CDK to ensure proper IAM to K8s RBAC Mapping
    Helm Chart Version are taken from cdk.json file or from command line parameter -c
    Helm Chart full version list can be found via helm repo list or viewing yaml file on github directly, see README.
    */

    /*
    Resources needed to create Fluent Bit DaemonSet
    Namespace
    Service Account Role
    IAM Policy
    K8s Manifest

    Current Config pushes to Cloudwatch , other outputs found here https://docs.fluentbit.io/manual/pipeline/outputs
    Fluentbit does not support IMDSv2
    https://github.com/fluent/fluent-bit/issues/2840#issuecomment-774393238
    */

    // YAML contains fluentbit parser configurations, remove namespace and serviceaccount from yaml to properly annotate with IAM Role
    const manifestFluentBitSetup = this.cleanManifest(
      'manifests/fluentBitSetup.yaml'
    );
    const fluentBitNamespace = new eks.KubernetesManifest(
      this,
      'amazon-cloudwatch-namespace',
      {
        cluster: props.eksCluster,
        manifest: [
          {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
              name: 'amazon-cloudwatch',
              labels: {
                name: 'amazon-cloudwatch',
              },
            },
          },
        ],
      }
    );
    const fluentBitSA = new eks.ServiceAccount(this, 'fluentbit-sa', {
      name: 'fluent-bit',
      namespace: 'amazon-cloudwatch',
      cluster: props.eksCluster,
    });
    fluentBitSA.node.addDependency(fluentBitNamespace);
    genPolicy.createFluentbitPolicy(
      this,
      props.eksCluster.clusterName,
      fluentBitSA.role
    );
    // Configurable variables for  manifests/fluentBitSetup.yaml
    const fluentBitClusterInfo = new eks.KubernetesManifest(
      this,
      'fluentbit-cluster-info',
      {
        cluster: props.eksCluster,
        manifest: [
          {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
              name: 'fluent-bit-cluster-info',
              namespace: 'amazon-cloudwatch',
              labels: {
                name: 'fluent-bit-cluster-info',
              },
            },
            data: {
              'cluster.name': props.eksCluster.clusterName,
              'http.port': '2020',
              'http.server': 'On',
              'logs.region': this.region,
              'read.head': 'Off',
              'read.tail': 'On',
            },
          },
        ],
      }
    );
    fluentBitClusterInfo.node.addDependency(fluentBitNamespace);
    const fluentBitResource = new eks.KubernetesManifest(
      this,
      'fluentbit-resource',
      {
        cluster: props.eksCluster,
        manifest: manifestFluentBitSetup,
      }
    );
    fluentBitResource.node.addDependency(fluentBitSA);
    fluentBitResource.node.addDependency(fluentBitClusterInfo);

    /*
    Resources needed to create ALB Ingress Controller
    Namespace
    Service Account Role
    IAM Policy
    Helm Chart
    AddOn: https://github.com/aws/containers-roadmap/issues/1162
    */

    // Create Namespace and Service Account for ALB Ingress
    const albNamespace = new eks.KubernetesManifest(
      this,
      'alb-ingress-controller-namespace',
      {
        cluster: props.eksCluster,
        manifest: [
          {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
              name: 'alb-ingress-controller',
              labels: {
                name: 'alb-ingress-controller',
              },
            },
          },
        ],
      }
    );
    const albSA = new eks.ServiceAccount(this, 'alb-ingress-controller-sa', {
      name: 'alb-ingress-controller-sa',
      namespace: 'alb-ingress-controller',
      cluster: props.eksCluster,
    });
    albSA.node.addDependency(albNamespace);

    // ALB Controller IAMPolicy
    genPolicy.createAlbIngressPolicy(
      this,
      props.eksCluster.clusterName,
      albSA.role
    );
    // https://github.com/aws/eks-charts/blob/master/stable/aws-load-balancer-controller/values.yaml
    const albIngressHelmChart = new eks.HelmChart(
      this,
      'alb-ingress-controller-chart',
      {
        chart: 'aws-load-balancer-controller',
        cluster: props.eksCluster,
        repository: 'https://aws.github.io/eks-charts',
        wait: true,
        release: 'aws-load-balancer-controller',
        createNamespace: true,
        namespace: 'alb-ingress-controller',
        // https://github.com/aws/eks-charts/blob/gh-pages/index.yaml
        version: this.node.tryGetContext(
          'aws-load-balancer-controller-helm-version'
        ),
        values: {
          clusterName: props.eksCluster.clusterName,
          defaultTags: {
            'eks:cluster-name': props.eksCluster.clusterName,
          },
          // Start - values needed if ec2metadata endpoint is unavailable - https://github.com/aws/eks-charts/tree/master/stable/aws-load-balancer-controller#configuration
          region: this.region,
          vpcId: props.eksCluster.vpc.vpcId,
          // End - values needed if ec2metadata endpoint is unavailable
          serviceAccount: {
            create: false,
            name: albSA.serviceAccountName,
          },
        },
      }
    );
    albIngressHelmChart.node.addDependency(albSA);
    /*
    Resources needed to create EBS CSI Driver
    Service Account Role
    IAM Policy
    Helm Chart
    Add On: https://github.com/aws/containers-roadmap/issues/247
    */

    // Create Service Account (Pod IAM Role Mapping) for EBS Controller
    const ebsSA = new eks.ServiceAccount(this, 'ebs-csi-controller-sa', {
      name: 'ebs-csi-controller-sa',
      namespace: 'kube-system',
      cluster: props.eksCluster,
    });

    // EBS Controller IAMPolicyDoc
    genPolicy.createEBSPolicy(this, props.eksCluster.clusterName, ebsSA.role);

    ebsSA.role.attachInlinePolicy(
      new iam.Policy(this, 'EncryptEBS', {
        statements: [
          new iam.PolicyStatement({
            actions: ['kms:CreateGrant', 'kms:ListGrants', 'kms:RevokeGrant'],
            effect: iam.Effect.ALLOW,
            resources: [props.eksKms.keyArn],
            conditions: {
              Bool: {
                'kms:GrantIsForAWSResource': 'true',
              },
            },
          }),
          new iam.PolicyStatement({
            actions: [
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            effect: iam.Effect.ALLOW,
            resources: [props.eksKms.keyArn],
          }),
        ],
      })
    );

    // Helm Chart Values: https://github.com/kubernetes-sigs/aws-ebs-csi-driver/blob/master/charts/aws-ebs-csi-driver/values.yaml
    const ebsCsiHelmChart = new eks.HelmChart(this, 'ebs-csi-helm-chart', {
      chart: 'aws-ebs-csi-driver',
      cluster: props.eksCluster,
      createNamespace: true,
      repository: 'https://kubernetes-sigs.github.io/aws-ebs-csi-driver',
      release: 'aws-ebs-csi-driver',
      namespace: 'kube-system',
      wait: true,
      // Helm Chart Versions: https://github.com/kubernetes-sigs/aws-ebs-csi-driver/blob/gh-pages/index.yaml
      version: this.node.tryGetContext('aws-ebs-csi-driver-helm-version'),
      values: {
        controller: {
          serviceAccount: {
            create: false,
            name: ebsSA.serviceAccountName,
          },
          extraVolumeTags: {
            'eks:cluster-name': props.eksCluster.clusterName,
          },
        },
      },
    });

    ebsCsiHelmChart.node.addDependency(ebsSA);
  }

  // Removes namespace and ServiceAccount objects from manifests, performing this in code to keep original manifest files.
  cleanManifest(file: string) {
    const manifest: Array<any> = yaml.loadAll(
      fs.readFileSync(file, 'utf-8'),
      null,
      { schema: yaml.JSON_SCHEMA }
    );
    return manifest.filter(
      (element) =>
        element.kind !== 'Namespace' && element.kind !== 'ServiceAccount'
    );
  }
}
