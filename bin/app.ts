#!/usr/bin/env node
import { App, Aspects } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EKS } from '../lib/eks';
import { EKSk8sBaseline } from '../lib/k8s-baseline';
import { NodeGroup } from '../lib/nodegroup';
import { Observe } from '../lib/observe';
import { VPC } from '../lib/vpc';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';

const DEFAULT_CONFIG = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

const app = new App();
Aspects.of(app).add(new AwsSolutionsChecks({verbose: true}));
const prefix = stackPrefix(app);

const vpc = new VPC(app, 'VPC', {
  env: DEFAULT_CONFIG.env,
});

const eks = new EKS(app, 'EKS', {
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EKS`,
  eksVpc: vpc.vpc,
});

const nodegroups = new NodeGroup(app, 'NodeGroup', {
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}NodeGroup`,
  eksVpc: vpc.vpc,
  eksCluster: eks.cluster,
  nodeGroupRole: eks.createNodegroupRole('erigon-ng'),
  bastionSecurityGroup: eks.bastionSecurityGroup,
  eksKms: eks.kms,
});

const k8sbase = new EKSk8sBaseline(app, 'EKSK8sBaseline', {
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}EKSK8sBaseline`,
  eksCluster: eks.cluster,
  eksKms: eks.kms,
});

const amp = new Observe(app, 'Observe', {
  env: DEFAULT_CONFIG.env,
  stackName: `${prefix}Observe`,
  eksKms: eks.kms,
  eksCluster: eks.cluster,
  vpc: vpc.vpc,
});

NagSuppressions.addStackSuppressions(nodegroups,[
  { id: 'AwsSolutions-EC23', reason: 'Nodes are run within private VPC' }
]);

NagSuppressions.addStackSuppressions(vpc,[
  { id: 'AwsSolutions-VPC7', reason: 'No VPC Flow Log required for PoC-grade deployment' },
]);

NagSuppressions.addStackSuppressions(k8sbase,[
  { id: 'AwsSolutions-IAM5', reason: 'Permission to read CF stack is restrictive enough' },
], true);

NagSuppressions.addStackSuppressions(eks,[
  { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole, AWSLambdaVPCAccessExecutionRole, AmazonEKS* are restrictive roles' },
  { id: 'AwsSolutions-IAM5', reason: 'Permission to read CF stack is restrictive enough' },
  { id: 'AwsSolutions-L1', reason: 'Non-container Lambda function managed by predefined EKS templates for CDK' },
  { id: 'AwsSolutions-EC23', reason: 'Bastion host must be publicly accessible' },
  { id: 'AwsSolutions-EC28', reason: 'Detailed monitoring not required for PoC-grade deployment' },
  { id: 'AwsSolutions-EC29', reason: 'Termination is disabled via property override, which cdk-nag does not account for' },
], true);

NagSuppressions.addStackSuppressions(amp,[
  { id: 'AwsSolutions-IAM5', reason: 'Permission to read CF stack is restrictive enough' },
], true);

nodegroups.addDependency(eks);
k8sbase.addDependency(nodegroups);
amp.addDependency(nodegroups);

function stackPrefix(stack: Construct): string {
  const prefixValue = stack.node.tryGetContext('stack_prefix');

  if (prefixValue !== undefined) {
    return prefixValue.trim();
  }
  // if no stack_prefix return empty string
  return '';
}
app.synth();
