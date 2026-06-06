@description('Azure region')
param location string
param tags object
param resourceToken string

@description('Base URL of the Axiom API the connector calls/trusts')
param axiomApiUrl string

@description('Container target port — must match the Dockerfile EXPOSE / PORT')
param targetPort int = 8210

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

var registryName = 'craxiommcp${resourceToken}'
var identityName = 'id-axiom-mcp-${resourceToken}'
var logAnalyticsName = 'log-axiom-mcp-${resourceToken}'
var environmentName = 'cae-axiom-mcp-${resourceToken}'
var appName = 'ca-axiom-mcp'

// User-assigned identity the container app uses to pull from ACR.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

// Azure Container Registry — azd builds and pushes the image here.
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource managedEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

// Public URL is deterministic from the environment's default domain, so we can
// pass the connector's own resource URL to itself as an env var at deploy time.
var publicUrl = 'https://${appName}.${managedEnv.properties.defaultDomain}'

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: union(tags, { 'azd-service-name': 'mcp' })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: managedEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          // Placeholder image; azd replaces this with the built image on deploy.
          name: 'mcp'
          image: 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: [
            { name: 'AXIOM_MCP_REMOTE', value: 'true' }
            { name: 'AXIOM_API_URL', value: axiomApiUrl }
            { name: 'MCP_PUBLIC_URL', value: publicUrl }
            { name: 'PORT', value: string(targetPort) }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 5
      }
    }
  }
  dependsOn: [
    acrPull
  ]
}

output registryLoginServer string = registry.properties.loginServer
output publicUrl string = publicUrl
output containerAppName string = containerApp.name
