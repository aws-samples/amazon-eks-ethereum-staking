import {
  InstanceType,
  AmazonLinuxImage,
  BlockDevice,
  EbsDeviceOptions,
} from 'aws-cdk-lib/aws-ec2';

export interface Config {
  accountId: string;

  region: string;

  // Cloudformation Stack Name
  stackName: string;

  vpcId?: string;

  instanceName: string;

  availabilityZone: string;

  userDataPath: string;

  instanceType: InstanceType;

  machineImage: AmazonLinuxImage;

  blockDevices?: BlockDevice[];
}
