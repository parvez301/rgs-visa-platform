import * as fs from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import {
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_authorizers as apigwAuthorizers,
  aws_apigatewayv2_integrations as apigwIntegrations,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as cloudfrontOrigins,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_events_targets as eventsTargets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";

export interface RgsPlatformStackProps extends cdk.StackProps {
  stage: string;
}

export class RgsPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RgsPlatformStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const isProduction = stage === "prod";
    const removalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ---------- Data ----------
    const platformTable = new dynamodb.Table(this, "PlatformTable", {
      tableName: `rgs-platform-${stage}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: isProduction },
    });
    for (const indexName of ["GSI1", "GSI2", "GSI3"] as const) {
      platformTable.addGlobalSecondaryIndex({
        indexName,
        partitionKey: { name: `${indexName}PK`, type: dynamodb.AttributeType.STRING },
        sortKey: { name: `${indexName}SK`, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    const documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: `rgs-documents-${stage}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy,
      autoDeleteObjects: !isProduction,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3600,
        },
      ],
    });

    // ---------- Auth ----------
    const usersPool = new cognito.UserPool(this, "UsersPool", {
      userPoolName: `rgs-users-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        fullname: { required: true, mutable: true },
        phoneNumber: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: false,
        requireUppercase: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    const usersPoolClient = usersPool.addClient("UsersWebClient", {
      authFlows: { userSrp: true, userPassword: true },
      preventUserExistenceErrors: true,
    });

    const adminsPool = new cognito.UserPool(this, "AdminsPool", {
      userPoolName: `rgs-admins-${stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 10, requireLowercase: true, requireDigits: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy,
    });
    const adminsPoolClient = adminsPool.addClient("AdminsWebClient", {
      authFlows: { userSrp: true, userPassword: true },
      preventUserExistenceErrors: true,
    });
    new cognito.CfnUserPoolGroup(this, "AdminsOwnerGroup", {
      groupName: "Owner",
      userPoolId: adminsPool.userPoolId,
    });
    for (const groupName of ["Ops", "Finance", "Viewer"]) {
      new cognito.CfnUserPoolGroup(this, `Admins${groupName}Group`, {
        groupName,
        userPoolId: adminsPool.userPoolId,
      });
    }
    // Owner seed is done post-deploy via CLI (AwsCustomResource cannot resolve
    // @aws-sdk/client-cognito-identity-provider from the CognitoIdentityProvider
    // service name). See deploy notes / admin-add-user-to-group after stack update.

    // ---------- Lambdas ----------
    const apiEntryFile = path.join(__dirname, "../../services/api/src/http/handler.ts");
    const sharedLambdaProps: Partial<lambdaNodejs.NodejsFunctionProps> = {
      entry: apiEntryFile,
      runtime: lambda.Runtime.NODEJS_22_X,
      memorySize: 512,
      timeout: cdk.Duration.seconds(15),
      architecture: lambda.Architecture.ARM_64,
      bundling: { minify: true, sourceMap: true, target: "node22" },
      environment: {
        TABLE_NAME: platformTable.tableName,
        DOCUMENTS_BUCKET: documentsBucket.bucketName,
        // From-domain must be SES-verified. raysglobalservices.com DNS still
        // points at GoDaddy (SES verify Failed). hireloop.xyz is verified in
        // the cloud account (us-east-1, production SES access). Lambdas assume
        // SES_ROLE_ARN to send there until the GoDaddy NS cutover.
        EMAIL_SENDER: "no-reply@hireloop.xyz",
        ADMIN_NOTIFICATION_EMAIL: "info@raysglobalservices.com",
        SES_REGION: "us-east-1",
        SES_ROLE_ARN: "arn:aws:iam::781517218736:role/RgsCrmSesSendRole",
        SES_EXTERNAL_ID: "rgs-crm-ses-send",
        NODE_OPTIONS: "--enable-source-maps",
      },
    };

    const userApiFunction = new lambdaNodejs.NodejsFunction(this, "UserApiFunction", {
      ...sharedLambdaProps,
      functionName: `rgs-user-api-${stage}`,
      handler: "userApiHandler",
    } as lambdaNodejs.NodejsFunctionProps);

    const adminApiFunction = new lambdaNodejs.NodejsFunction(this, "AdminApiFunction", {
      ...sharedLambdaProps,
      functionName: `rgs-admin-api-${stage}`,
      handler: "adminApiHandler",
    } as lambdaNodejs.NodejsFunctionProps);
    adminApiFunction.addEnvironment("ADMINS_USER_POOL_ID", adminsPool.userPoolId);
    adminApiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminDisableUser",
          "cognito-idp:AdminEnableUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:ListUsers",
        ],
        resources: [adminsPool.userPoolArn],
      }),
    );

    const sesAssumeRoleArn = "arn:aws:iam::781517218736:role/RgsCrmSesSendRole";
    for (const apiFunction of [userApiFunction, adminApiFunction]) {
      platformTable.grantReadWriteData(apiFunction);
      documentsBucket.grantReadWrite(apiFunction);
      apiFunction.addToRolePolicy(
        new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }),
      );
      apiFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [sesAssumeRoleArn],
        }),
      );
    }

    // Daily appointment reminders (24–48h window) — same entry file, own handler.
    const appointmentRemindersFunction = new lambdaNodejs.NodejsFunction(
      this,
      "AppointmentRemindersFunction",
      {
        ...sharedLambdaProps,
        functionName: `rgs-appointment-reminders-${stage}`,
        handler: "appointmentRemindersHandler",
        timeout: cdk.Duration.minutes(5),
      } as lambdaNodejs.NodejsFunctionProps,
    );
    appointmentRemindersFunction.addEnvironment(
      "ADMINS_USER_POOL_ID",
      adminsPool.userPoolId,
    );
    platformTable.grantReadWriteData(appointmentRemindersFunction);
    appointmentRemindersFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }),
    );
    appointmentRemindersFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [sesAssumeRoleArn],
      }),
    );
    new events.Rule(this, "AppointmentRemindersSchedule", {
      ruleName: `rgs-appointment-reminders-${stage}`,
      description: "Email partners for CRM appointments 1–2 days out",
      schedule: events.Schedule.cron({ minute: "0", hour: "3" }),
      targets: [new eventsTargets.LambdaFunction(appointmentRemindersFunction)],
    });

    // ---------- HTTP API ----------
    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `rgs-api-${stage}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ["content-type", "authorization"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    const userIntegration = new apigwIntegrations.HttpLambdaIntegration(
      "UserIntegration",
      userApiFunction,
    );
    const adminIntegration = new apigwIntegrations.HttpLambdaIntegration(
      "AdminIntegration",
      adminApiFunction,
    );
    const usersAuthorizer = new apigwAuthorizers.HttpJwtAuthorizer(
      "UsersJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${usersPool.userPoolId}`,
      { jwtAudience: [usersPoolClient.userPoolClientId] },
    );
    const adminsAuthorizer = new apigwAuthorizers.HttpJwtAuthorizer(
      "AdminsJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${adminsPool.userPoolId}`,
      { jwtAudience: [adminsPoolClient.userPoolClientId] },
    );

    // Public routes (no auth): leads + live catalog
    httpApi.addRoutes({
      path: "/api/v1/leads",
      methods: [apigwv2.HttpMethod.POST],
      integration: userIntegration,
    });
    httpApi.addRoutes({
      path: "/api/v1/config/countries",
      methods: [apigwv2.HttpMethod.GET],
      integration: userIntegration,
    });
    // Public notice board (marketing site reads this)
    httpApi.addRoutes({
      path: "/api/v1/notices",
      methods: [apigwv2.HttpMethod.GET],
      integration: userIntegration,
    });
    // Authenticated user routes
    httpApi.addRoutes({
      path: "/api/v1/applications",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: userIntegration,
      authorizer: usersAuthorizer,
    });
    // User profile bootstrap (persisted USER#…/PROFILE)
    httpApi.addRoutes({
      path: "/api/v1/me",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: userIntegration,
      authorizer: usersAuthorizer,
    });
    httpApi.addRoutes({
      path: "/api/v1/applications/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PATCH,
      ],
      integration: userIntegration,
      authorizer: usersAuthorizer,
    });
    // Admin routes
    httpApi.addRoutes({
      path: "/api/v1/admin/{proxy+}",
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.DELETE,
      ],
      integration: adminIntegration,
      authorizer: adminsAuthorizer,
    });

    // ---------- Marketing hosting ----------
    const marketingBucket = new s3.Bucket(this, "MarketingBucket", {
      bucketName: `rgs-marketing-${stage}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy,
      autoDeleteObjects: !isProduction,
    });

    // Map /about/ -> /about/index.html for the static export
    const directoryIndexFunction = new cloudfront.Function(this, "DirectoryIndexFn", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
  } else if (!uri.includes('.')) {
    request.uri = uri + '/index.html';
  }
  return request;
}
`),
    });

    const marketingDistribution = new cloudfront.Distribution(this, "MarketingDistribution", {
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(marketingBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: directoryIndexFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: "/404.html" },
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: "/404.html" },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      comment: `RGS marketing (${stage})`,
    });

    new s3deploy.BucketDeployment(this, "MarketingDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../apps/marketing/out"))],
      destinationBucket: marketingBucket,
      distribution: marketingDistribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });

    // ---------- Portal + Admin SPA hosting ----------
    const { distribution: portalDistribution } = this.createSpaHosting({
      stage,
      removalPolicy,
      autoDeleteObjects: !isProduction,
      idPrefix: "Portal",
      bucketName: `rgs-portal-${stage}-${this.account}`,
      distRelativePath: "../../apps/portal/dist",
      comment: `RGS portal (${stage})`,
    });

    const { distribution: adminDistribution } = this.createSpaHosting({
      stage,
      removalPolicy,
      autoDeleteObjects: !isProduction,
      idPrefix: "Admin",
      bucketName: `rgs-admin-${stage}-${this.account}`,
      distRelativePath: "../../apps/admin/dist",
      comment: `RGS admin (${stage})`,
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "MarketingUrl", {
      value: `https://${marketingDistribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "PortalUrl", {
      value: `https://${portalDistribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "AdminUrl", {
      value: `https://${adminDistribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "TableName", { value: platformTable.tableName });
    new cdk.CfnOutput(this, "DocumentsBucketName", { value: documentsBucket.bucketName });
    new cdk.CfnOutput(this, "UsersPoolId", { value: usersPool.userPoolId });
    new cdk.CfnOutput(this, "UsersPoolClientId", { value: usersPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "AdminsPoolId", { value: adminsPool.userPoolId });
    new cdk.CfnOutput(this, "AdminsPoolClientId", { value: adminsPoolClient.userPoolClientId });
  }

  private createSpaHosting(options: {
    stage: string;
    removalPolicy: cdk.RemovalPolicy;
    autoDeleteObjects: boolean;
    idPrefix: string;
    bucketName: string;
    distRelativePath: string;
    comment: string;
  }): { bucket: s3.Bucket; distribution: cloudfront.Distribution } {
    const spaBucket = new s3.Bucket(this, `${options.idPrefix}Bucket`, {
      bucketName: `${options.bucketName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: options.removalPolicy,
      autoDeleteObjects: options.autoDeleteObjects,
    });

    const spaDistribution = new cloudfront.Distribution(this, `${options.idPrefix}Distribution`, {
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(spaBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      comment: options.comment,
    });

    const distAbsolutePath = path.join(__dirname, options.distRelativePath);
    const deploymentSources = fs.existsSync(distAbsolutePath)
      ? [s3deploy.Source.asset(distAbsolutePath)]
      : [
          s3deploy.Source.data(
            "index.html",
            `<!doctype html><title>${options.idPrefix} build missing</title><p>Run pnpm --filter @rgs/${options.idPrefix.toLowerCase()} build before deploy.</p>`,
          ),
        ];

    new s3deploy.BucketDeployment(this, `${options.idPrefix}Deployment`, {
      sources: deploymentSources,
      destinationBucket: spaBucket,
      distribution: spaDistribution,
      distributionPaths: ["/*"],
      memoryLimit: 512,
    });

    return { bucket: spaBucket, distribution: spaDistribution };
  }
}
