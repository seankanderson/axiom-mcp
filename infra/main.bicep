targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the azd environment (e.g. "prod")')
param environmentName string

@minLength(1)
@description('Azure region for all resources')
param location string

@description('Base URL of the Axiom API the connector calls and trusts for OAuth, e.g. https://api.axiom-billing.com/api')
param axiomApiUrl string

@description('Resource group to deploy into. Defaults to the shared "axiom" group used by axiom-api.')
param resourceGroupName string = 'axiom'

@description('Custom domain for the connector; a free managed TLS cert is auto-provisioned and bound. Empty = default ACA domain only. DNS (CNAME + asuid TXT) must exist first.')
param customDomain string = 'mcp.axiom-billing.com'

var resourceToken = toLower(uniqueString(subscription().subscriptionId, environmentName, location, 'axiom-mcp'))
var tags = { 'azd-env-name': environmentName, project: 'axiom-mcp' }

// Reuse the existing resource group created by the axiom-api deployment.
resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' existing = {
  name: resourceGroupName
}

module resources 'resources.bicep' = {
  name: 'axiom-mcp-resources'
  scope: rg
  params: {
    location: location
    tags: tags
    resourceToken: resourceToken
    axiomApiUrl: axiomApiUrl
    customDomain: customDomain
  }
}

// Consumed by azd: where to push the built image, and the connector URL.
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.registryLoginServer
output AZURE_RESOURCE_GROUP string = rg.name
output MCP_PUBLIC_URL string = resources.outputs.publicUrl
output MCP_CONNECTOR_ENDPOINT string = resources.outputs.publicUrl
