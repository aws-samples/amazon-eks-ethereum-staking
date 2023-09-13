import * as fs from 'fs';
import * as cdk from 'aws-cdk-lib';
import { KubectlV25Layer } from "@aws-cdk/lambda-layer-kubectl-v25";
import { CfnJson, CfnResource } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import * as yaml from 'js-yaml';

type eksStackProps = cdk.StackProps & {
  eksVpc: ec2.Vpc;
};

export class EKS extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  public readonly awsauth: eks.AwsAuth;
  public readonly bastionSecurityGroup: ec2.SecurityGroup;
  public readonly kms: Key;

  constructor(scope: Construct, id: string, props: eksStackProps) {
    super(scope, id, props);
    this.bastionSecurityGroup = new ec2.SecurityGroup(
      this,
      'bastionHostSecurityGroup',
      {
        allowAllOutbound: false,
        vpc: props.eksVpc,
      }
    );
    // Recommended to use connections to manage ingress/egress for security groups
    this.bastionSecurityGroup.connections.allowTo(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Outbound to 443 only'
    );
    this.bastionSecurityGroup.connections.allowFrom(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH'
    );

    // Create Custom IAM Role and Policies for Bastion Host
    // https://docs.aws.amazon.com/eks/latest/userguide/security_iam_id-based-policy-examples.html#policy_example3
    const bastionHostPolicy = new iam.ManagedPolicy(
      this,
      'bastionHostManagedPolicy'
    );
    bastionHostPolicy.addStatements(
      new iam.PolicyStatement({
        resources: ['*'],
        actions: [
          'eks:DescribeNodegroup',
          'eks:ListNodegroups',
          'eks:DescribeCluster',
          'eks:ListClusters',
          'eks:AccessKubernetesApi',
          'eks:ListUpdates',
          'eks:ListFargateProfiles',
        ],
        effect: iam.Effect.ALLOW,
        sid: 'EKSReadonly',
      })
    );
    const bastionHostRole = new iam.Role(this, 'bastionHostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore'
        ),
        bastionHostPolicy,
      ],
    });

    const KEY_PAIR_NAME = 'bastionHostKeyPair';
    const cfnKeyPair = new ec2.CfnKeyPair(this, 'BastionHost', {
      keyName: KEY_PAIR_NAME,
    });

    // Create Bastion Host, connect using Session Manager, or SSH
    const bastionHostLinux = new ec2.Instance(this, 'BastionEKSHost', {
      vpc: props.eksVpc,
      vpcSubnets:
        {
          subnetGroupName: 'eks-dmz',
        },
      keyName: KEY_PAIR_NAME,
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/ami-amazon-linux-latest/amzn2-ami-hvm-arm64-gp2'
      ),
      securityGroup: this.bastionSecurityGroup,
      role: bastionHostRole,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(10, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    (bastionHostLinux.node.defaultChild as ec2.CfnInstance).addPropertyOverride("DisableApiTermination", true);

    // Need KMS Key for EKS Envelope Encryption, if deleted, KMS will wait default (30 days) time before removal.
    this.kms = new Key(this, 'ekskmskey', {
      enableKeyRotation: true,
    });

    this.cluster = new eks.Cluster(this, 'EKSCluster', {
      version: eks.KubernetesVersion.V1_25,
      defaultCapacity: 0,
      endpointAccess: eks.EndpointAccess.PRIVATE,
      vpc: props.eksVpc,
      kubectlLayer: new KubectlV25Layer(this, 'KubectlLayer'),
      secretsEncryptionKey: this.kms,
      mastersRole: bastionHostLinux.role,
      vpcSubnets: [
        {
          subnetGroupName: 'eks-cluster',
        },
      ],
      // Ensure EKS helper lambdas are in private subnets
      placeClusterHandlerInVpc: true,
      clusterLogging: [
        eks.ClusterLoggingTypes.API,
        eks.ClusterLoggingTypes.AUTHENTICATOR,
        eks.ClusterLoggingTypes.SCHEDULER,
        eks.ClusterLoggingTypes.AUDIT,
        eks.ClusterLoggingTypes.CONTROLLER_MANAGER,
      ],
    });

    this.cluster.clusterSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.allTraffic(),
      'Allow VPC'
    );

    this.kms.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        actions: [
          'kms:GenerateDataKey*',
          'kms:Decrypt*',
          'kms:Encrypt*',
          'kms:Describe*',
          'kms:ReEncrypt*',
        ],
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
          },
        },
      })
    );

    this.kms.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ArnPrincipal('*')],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        effect: iam.Effect.ALLOW,
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': this.account,
            'kms:ViaService': `ec2.${this.region}.amazonaws.com`,
          },
          'ForAnyValue:StringEquals': {
            'kms:EncryptionContextKeys': 'aws:ebs:id',
          },
        },
      })
    );

    // Allow BastionHost security group access to EKS Control Plane
    bastionHostLinux.connections.allowTo(
      this.cluster,
      ec2.Port.tcp(443),
      'Allow between BastionHost and EKS '
    );
    // Install kubectl version similar to EKS k8s version
    bastionHostLinux.userData.addCommands(
      'yum update -y',
      'yum install -y git',
      'yum remove -y awscli',
      'rm -rf /usr/local/aws-cli',
      'curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"',
      'unzip awscliv2.zip -d awscliv2',
      './awscliv2/aws/install ',
      'ln -s /usr/local/bin/aws /usr/bin/aws',
      'rm -rf awscliv2.zip',
      'curl -O https://s3.us-west-2.amazonaws.com/amazon-eks/1.24.10/2023-01-30/bin/linux/arm64/kubectl',
      'chmod +x ./kubectl',
      'mkdir -p $HOME/bin && cp ./kubectl $HOME/bin/kubectl && export PATH=$PATH:$HOME/bin',
      "echo 'export PATH=$PATH:$HOME/bin' >> ~/.bashrc",
      'curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh"  | bash',
      'curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3',
      'chmod 700 get_helm.sh',
      './get_helm.sh',
      'rm -rf get_helm.sh',
      `aws eks update-kubeconfig --name ${this.cluster.clusterName} --region ${this.region}`
    );
    this.awsauth = new eks.AwsAuth(this, 'EKS_AWSAUTH', {
      cluster: this.cluster,
    });

    // deploy Custom k8s RBAC group to provide EKS Web Console read only permissions https://docs.aws.amazon.com/eks/latest/userguide/add-user-role.html
    // https://aws.github.io/aws-eks-best-practices/security/docs/iam.html#employ-least-privileged-access-when-creating-rolebindings-and-clusterrolebindings
    const manifestConsoleViewGroup: Array<any> = yaml.loadAll(
      fs.readFileSync('manifests/consoleViewOnlyGroup.yaml', 'utf-8')
    );
    const manifestConsoleViewGroupDeploy = new eks.KubernetesManifest(
      this,
      'eks-group-view-only',
      {
        cluster: this.cluster,
        manifest: manifestConsoleViewGroup,
      }
    );
    this.awsauth.node.addDependency(manifestConsoleViewGroupDeploy);
    this.awsauth.addMastersRole(
      bastionHostLinux.role,
      `${bastionHostLinux.role.roleArn}/{{SessionName}}`
    );
    // Patch aws-node daemonset to use IRSA via EKS Addons, do before nodes are created
    // https://aws.github.io/aws-eks-best-practices/security/docs/iam/#update-the-aws-node-daemonset-to-use-irsa
    const awsNodeconditionsPolicy = new CfnJson(
      this,
      'awsVpcCniconditionPolicy',
      {
        value: {
          [`${this.cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]:
            'sts.amazonaws.com',
          [`${this.cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]:
            'system:serviceaccount:kube-system:aws-node',
        },
      }
    );
    const awsNodePrincipal = new iam.OpenIdConnectPrincipal(
      this.cluster.openIdConnectProvider
    ).withConditions({
      StringEquals: awsNodeconditionsPolicy,
    });
    const awsVpcCniRole = new iam.Role(this, 'awsVpcCniRole', {
      assumedBy: awsNodePrincipal,
    });

    awsVpcCniRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy')
    );
    (() =>
      new eks.CfnAddon(this, 'vpc-cni', {
        addonName: 'vpc-cni',
        resolveConflicts: 'OVERWRITE',
        serviceAccountRoleArn: awsVpcCniRole.roleArn,
        clusterName: this.cluster.clusterName,
        addonVersion: this.node.tryGetContext('eks-addon-vpc-cni-version'),
      }))();
    (() =>
      new eks.CfnAddon(this, 'kube-proxy', {
        addonName: 'kube-proxy',
        resolveConflicts: 'OVERWRITE',
        clusterName: this.cluster.clusterName,
        addonVersion: this.node.tryGetContext('eks-addon-kube-proxy-version'),
      }))();
    (() =>
      new eks.CfnAddon(this, 'core-dns', {
        addonName: 'coredns',
        resolveConflicts: 'OVERWRITE',
        clusterName: this.cluster.clusterName,
        addonVersion: this.node.tryGetContext('eks-addon-coredns-version'),
      }))();
  }

  // Create nodegroup IAM role in same stack as eks cluster to ensure there is not a circular dependency
  public createNodegroupRole(id: string): iam.Role {
    const role = new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy')
    );
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'AmazonEC2ContainerRegistryReadOnly'
      )
    );
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'CloudWatchAgentServerPolicy'
      )
    );
    this.awsauth.addRoleMapping(role, {
      username: 'system:node:{{EC2PrivateDNSName}}',
      groups: ['system:bootstrappers', 'system:nodes'],
    });
    return role;
  }

}
