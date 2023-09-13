import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { aws_grafana as grafana } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import { CfnJson } from 'aws-cdk-lib';

type observeProps = cdk.StackProps & {
  eksCluster: eks.Cluster;
  eksKms: kms.Key;
  vpc: ec2.Vpc;
};

export class Observe extends cdk.Stack {
  constructor(scope: Construct, id: string, props: observeProps) {
    super(scope, id, props);

    const ampLogGroup = new logs.LogGroup(this, 'AmpLogGroup', {
      retention: logs.RetentionDays.ONE_WEEK,
      encryptionKey: props.eksKms,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const cfnWorkspace = new aps.CfnWorkspace(this, 'PrometheusWorkspace', {
      loggingConfiguration: {
        logGroupArn: ampLogGroup.logGroupArn,
      },
    });

    const ingestCondition = new CfnJson(this, 'IngestCondition', {
      value: {
        [`${props.eksCluster.clusterOpenIdConnectIssuer}:sub`]:
          'system:serviceaccount:monitoring:amp-iamproxy-ingest-service-account',
      },
    });

    const ingestRole = new iam.Role(this, 'IngestRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.WebIdentityPrincipal(
          `arn:aws:iam::${this.account}:oidc-provider/${props.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer}`
        ),
        {
          StringEquals: ingestCondition,
        }
      ),
      description: 'Role for ingesting Prometheus metrics',
      inlinePolicies: {
        amp: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'aps:RemoteWrite',
                'aps:GetSeries',
                'aps:GetLabels',
                'aps:GetMetricMetadata',
              ],
              effect: iam.Effect.ALLOW,
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    const queryCondition = new CfnJson(this, 'QueryCondition', {
      value: {
        [`${props.eksCluster.clusterOpenIdConnectIssuer}:sub`]: [
          'system:serviceaccount:monitoring:amp-iamproxy-query-service-account',
          'system:serviceaccount:monitoring:amp-iamproxy-query-service-account',
        ],
      },
    });

    new iam.Role(this, 'QueryRole', {
      assumedBy: new iam.PrincipalWithConditions(
        new iam.WebIdentityPrincipal(
          `arn:aws:iam::${this.account}:oidc-provider/${props.eksCluster.openIdConnectProvider.openIdConnectProviderIssuer}`
        ),
        {
          StringEquals: queryCondition,
        }
      ),
      description: 'Role for querying Prometheus metrics',
      inlinePolicies: {
        amp: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'aps:QueryMetrics',
                'aps:GetSeries',
                'aps:GetLabels',
                'aps:GetMetricMetadata',
              ],
              effect: iam.Effect.ALLOW,
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    new eks.HelmChart(this, 'Prometheus', {
      cluster: props.eksCluster,
      chart: 'kube-prometheus-stack',
      repository: 'https://prometheus-community.github.io/helm-charts',
      namespace: 'monitoring',
      release: 'kube-prometheus',
      createNamespace: true,
      values: {
        prometheus: {
          serviceAccount: {
            create: true,
            name: 'amp-iamproxy-ingest-service-account',
            annotations: {
              'eks.amazonaws.com/role-arn': ingestRole.roleArn,
            },
          },
          prometheusSpec: {
            remoteWrite: [
              {
                url: `https://aps-workspaces.${this.region}.amazonaws.com/workspaces/${cfnWorkspace.attrWorkspaceId}/api/v1/remote_write`,
                sigv4: {
                  region: this.region,
                },
                queueConfig: {
                  maxSamplesPerSend: 1000,
                  maxShards: 200,
                  capacity: 2500,
                },
              },
            ],
          },
        },
        alertmaanger: {
          enabled: false
        },
        grafana: {
          enabled: false
        },
        promtheusOperator: {
          tls: {
            enabled: false
          },
          admissionWebhooks: {
            enabled: false,
            patch: {
              enabled: false
            }
          },
        },
      },
    });

    const grafanaRole = new iam.Role(this, 'GrafanaRole', {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
      description: 'Role used to administer Grafana workspace for Ethereum',
      inlinePolicies: {
        'list-amp': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['aps:ListWorkspaces'],
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:aps:${this.region}:${this.account}:/workspaces`,
              ],
            }),
          ],
        }),
        'query-amp': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'aps:GetLabels',
                'aps:GetMetricMetadata',
                'aps:GetSeries',
                'aps:QueryMetrics',
                'aps:DescribeWorkspace',
              ],
              effect: iam.Effect.ALLOW,
              resources: [cfnWorkspace.attrArn],
            }),
          ],
        }),
      },
    });

    const grafanaSg = new ec2.SecurityGroup(this, 'GrafanaSG', {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: 'Amazon Managed Grafana Security Group for Ethereum',
    });

    new grafana.CfnWorkspace(this, 'Grafana', {
      accountAccessType: 'CURRENT_ACCOUNT',
      description: 'Ethereum Client',
      permissionType: 'SERVICE_MANAGED',
      roleArn: grafanaRole.roleArn,
      authenticationProviders: ['AWS_SSO'],
      notificationDestinations: ['SNS'],
      vpcConfiguration: {
        securityGroupIds: [grafanaSg.securityGroupId],
        subnetIds: props.vpc.selectSubnets({ subnetGroupName: 'eks-nodes' })
          .subnetIds,
      },
    });
  }
}
