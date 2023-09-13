import * as cdk from 'aws-cdk-lib';
import { Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

type k8snodegroupsProps = cdk.StackProps & {
  eksVpc: ec2.Vpc;
  eksCluster: eks.Cluster;
  nodeGroupRole: iam.Role;
  bastionSecurityGroup: ec2.SecurityGroup;
  eksKms: kms.Key;
};

export class NodeGroup extends cdk.Stack {
  constructor(scope: Construct, id: string, props: k8snodegroupsProps) {
    super(scope, id, props);

    const userData = ec2.UserData.forLinux();
    userData.addCommands('#!/bin/bash', 'yum update -y');

    const multipartUserData = new ec2.MultipartUserData();
    multipartUserData.addPart(ec2.MultipartBody.fromUserData(userData));

    const ngsg = new ec2.SecurityGroup(this, 'NodeGroupSG', {
      vpc: props.eksVpc,
      allowAllOutbound: true,
      description: 'Node Group SG',
    });

    // For Erigon: https://github.com/ledgerwatch/erigon#default-ports-and-protocols--firewalls
    // public
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(30303),
      'eth/66 peering'
    );
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(30303),
      'eth/66 peering'
    );
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(30304),
      'eth/67 peering'
    );
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(30304),
      'eth/67 peering'
    );
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(42069),
      'Snap sync (Bittorrent)'
    );
    ngsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(42069),
      'Snap sync (Bittorrent)'
    );
    ngsg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4000), 'Peering');
    ngsg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(4001), 'Peering');

    // private
    ngsg.addIngressRule(
      ec2.Peer.securityGroupId(props.bastionSecurityGroup.securityGroupId),
      ec2.Port.tcp(443),
      'Bastion Host'
    );
    ngsg.addIngressRule(
      ec2.Peer.securityGroupId(props.eksCluster.clusterSecurityGroupId),
      ec2.Port.allTraffic(),
      'EKS'
    );
    ngsg.addIngressRule(
      ngsg,
      ec2.Port.udpRange(20,60),
      'Kubernetes DNS'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9090),
      'gRPC Connections'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(6060),
      'Metrics or Pprof'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(8551),
      'Engine API (JWT auth)'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(8545),
      'RPC'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9091),
      'gRPC Connections'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(7777),
      'gRPC Connections'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(6060),
      'pprof/metrics'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9092),
      'gRPC (reserved)'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9093),
      'gRPC (reserved)'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9094),
      'gRPC (reserved)'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(9100),
      'prometheus node-exporter metrics'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(10249),
      'prometheus kube-proxy metrics'
    );
    ngsg.addIngressRule(
      ec2.Peer.ipv4(props.eksVpc.vpcCidrBlock),
      ec2.Port.tcp(10250),
      'prometheus kubelete metrics'
    );

    const launchtemplate = new ec2.CfnLaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateData: {
        instanceType: 'r7g.2xlarge',
        securityGroupIds: [ngsg.securityGroupId],
        userData: Fn.base64(multipartUserData.render()),
      },
    });

    function getNodeGroupAzs(azs: string | undefined): string[] | undefined {
      return azs?.split(',') ?? undefined;
    }

    new eks.Nodegroup(this, 'NodeGroup', {
      amiType: eks.NodegroupAmiType.AL2_ARM_64,
      cluster: props.eksCluster,
      nodeRole: props.nodeGroupRole,
      maxSize: this.node.tryGetContext('nodeGroupMaxSize'),
      desiredSize: this.node.tryGetContext('nodeGroupDesiredSize'),
      minSize: this.node.tryGetContext('nodeGroupMinSize'),
      subnets: {
        availabilityZones: getNodeGroupAzs(
          this.node.tryGetContext('availability_zones')
        ),
        subnetGroupName: 'eks-nodes',
      },
      launchTemplateSpec: {
        id: launchtemplate.ref,
        version: launchtemplate.attrLatestVersionNumber,
      },
      tags: {
        Name: Fn.join('-', [props.eksCluster.clusterName, 'WorkerNodes']),
      },
    });

    // Permissions for SSM Manager for core functionality
    props.nodeGroupRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
  }
}
