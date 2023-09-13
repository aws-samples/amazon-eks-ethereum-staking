import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class VPC extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const eksUnsupportedAzs: string[] = ['us-east-1e'];

    this.vpc = new ec2.Vpc(this, 'erigon', {
      ipAddresses: ec2.IpAddresses.cidr(this.node.tryGetContext('vpcCidr')),
      natGateways: 1,
      enableDnsSupport: true,
      enableDnsHostnames: true,
      availabilityZones: this.availabilityZones.filter(
        (az) => !eksUnsupportedAzs.includes(az)
      ),
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: 'eks-dmz',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 21,
          name: 'eks-cluster',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 20,
          name: 'eks-nodes',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    const ampInterfaceEndpointSG = new ec2.SecurityGroup(
      this,
      'AMPInterfaceEndpointSG',
      {
        vpc: this.vpc,
        allowAllOutbound: true,
        description: 'AMP Interface Endpoint SG',
        // securityGroupName: `amp-interface-endpoint-${this.node.addr}`,
      }
    );

    this.vpc
      .selectSubnets({ subnetGroupName: 'eks-nodes' })
      .subnets.forEach((subnet) => {
        ampInterfaceEndpointSG.addIngressRule(
          ec2.Peer.ipv4(subnet.ipv4CidrBlock),
          ec2.Port.tcp(443),
          'EKS Nodes'
        );
      });

    this.vpc.addInterfaceEndpoint('PrometheusEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${this.region}.aps`
      ),
      securityGroups: [ampInterfaceEndpointSG],
      open: false,
      subnets: {
        subnetGroupName: 'eks-nodes',
      },
    });

    this.vpc.addInterfaceEndpoint('PrometheusWorkspacesEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${this.region}.aps-workspaces`
      ),
      securityGroups: [ampInterfaceEndpointSG],
      open: false,
      subnets: {
        subnetGroupName: 'eks-nodes',
      },
    });

    this.vpc.addInterfaceEndpoint('GrafanaEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${this.region}.grafana`
      ),
      securityGroups: [ampInterfaceEndpointSG],
      open: false,
      subnets: {
        subnetGroupName: 'eks-nodes',
      },
    });

    this.vpc.addInterfaceEndpoint('GrafanaWorkspacesEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(
        `com.amazonaws.${this.region}.grafana-workspace`
      ),
      securityGroups: [ampInterfaceEndpointSG],
      open: false,
      subnets: {
        subnetGroupName: 'eks-nodes',
      },
    });
  }
}
