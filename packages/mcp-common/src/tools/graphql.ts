import { z } from 'zod'
import { type CloudflareMcpAgent } from '../types/cloudflare-mcp-agent'

const MISSING_ACCOUNT_ID_RESPONSE = {
  content: [
    {
      type: 'text',
      text: 'No currently active accountId. Try listing your accounts (accounts_list) and then setting an active account (set_active_account)',
    },
  ],
}

const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
const MAX_TYPES_PER_PAGE = 5
const MAX_FIELDS_PER_TYPE = 10

async function getGraphQLSchema(accessToken: string) {
  const response = await fetch(CLOUDFLARE_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: `
        query IntrospectionQuery {
          __schema {
            types {
              name
              kind
              description
              fields {
                name
                description
                type {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
              }
            }
          }
        }
      `,
    }),
  })

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }

  return response.json()
}

function extractKeyTerms(query: string): string[] {
  // Remove common question words and focus on the key terms
  const wordsToRemove = new Set([
    'what', 'are', 'available', 'about', 'show', 'me', 'the', 'data', 'for',
    'fields', 'types', 'queries', 'query', 'schema', 'information'
  ])
  
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(word => !wordsToRemove.has(word))
    .filter(word => word.length > 2) // Remove very short words
}

function findRelevantTypes(schema: any, searchTerms: string[]) {
  const types = schema.data.__schema.types
  const relevantTypes = types.filter((type: any) => {
    // Check if any search term matches the type name, description, or fields
    return searchTerms.some(term => {
      const nameMatch = type.name.toLowerCase().includes(term)
      const descriptionMatch = type.description?.toLowerCase().includes(term)
      const fieldsMatch = type.fields?.some((field: any) => 
        field.name.toLowerCase().includes(term) ||
        field.description?.toLowerCase().includes(term)
      )
      return nameMatch || descriptionMatch || fieldsMatch
    })
  })

  return relevantTypes.map((type: any) => ({
    name: type.name,
    description: type.description,
    fields: type.fields?.map((field: any) => ({
      name: field.name,
      description: field.description,
      type: field.type.name || field.type.ofType?.name
    }))
  }))
}

function formatTypeInfo(type: any, showAllFields: boolean = false) {
  const fields = type.fields || []
  const displayedFields = showAllFields ? fields : fields.slice(0, MAX_FIELDS_PER_TYPE)
  
  let result = `Type: ${type.name}\n`
  if (type.description) {
    result += `Description: ${type.description}\n`
  }
  result += `Fields:\n${displayedFields.map((field: any) => 
    `- ${field.name} (${field.type}): ${field.description || 'No description available'}`
  ).join('\n')}`
  
  if (!showAllFields && fields.length > MAX_FIELDS_PER_TYPE) {
    result += `\n... and ${fields.length - MAX_FIELDS_PER_TYPE} more fields`
  }
  
  return result
}

export function registerGraphQLTools(agent: CloudflareMcpAgent) {
  // Tool to explore GraphQL schema using natural language
  const searchTermParam = z.string().describe('The natural language query about what data you want to explore')
  const pageParam = z.number().optional().describe('Page number for paginated results')
  agent.server.tool(
    'explore_graphql_schema',
    'Explore the GraphQL schema using natural language queries',
    { searchTerm: searchTermParam, page: pageParam },
    async ({ searchTerm, page = 1 }) => {
      const account_id = agent.getActiveAccountId()
      if (!account_id) {
        return MISSING_ACCOUNT_ID_RESPONSE
      }
      try {
        const schema = await getGraphQLSchema(agent.props.accessToken)
        const keyTerms = extractKeyTerms(searchTerm)
        
        if (keyTerms.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: "I couldn't identify any specific terms to search for. Try being more specific about what you're looking for.",
              },
            ],
          }
        }

        const relevantTypes = findRelevantTypes(schema, keyTerms)

        if (relevantTypes.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `No data found related to "${keyTerms.join(' ')}". Try using different terms or being more specific.`,
              },
            ],
          }
        }

        const startIdx = (page - 1) * MAX_TYPES_PER_PAGE
        const endIdx = startIdx + MAX_TYPES_PER_PAGE
        const paginatedTypes = relevantTypes.slice(startIdx, endIdx)
        const totalPages = Math.ceil(relevantTypes.length / MAX_TYPES_PER_PAGE)

        let response = `Found ${relevantTypes.length} types related to "${keyTerms.join(' ')}"\n`
        response += `Showing page ${page} of ${totalPages}\n\n`
        
        response += paginatedTypes.map(type => formatTypeInfo(type)).join('\n\n')

        if (page < totalPages) {
          response += `\n\nUse page=${page + 1} to see more results`
        }

        return {
          content: [
            {
              type: 'text',
              text: response,
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error exploring schema: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )

  // Tool to execute a GraphQL query
  const queryParam = z.string().describe('The GraphQL query to execute')
  agent.server.tool(
    'graphql_query',
    'Execute a GraphQL query against the Cloudflare API',
    { query: queryParam },
    async ({ query }) => {
      const account_id = agent.getActiveAccountId()
      if (!account_id) {
        return MISSING_ACCOUNT_ID_RESPONSE
      }
      try {
        const response = await fetch(CLOUDFLARE_GRAPHQL_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${agent.props.accessToken}`,
          },
          body: JSON.stringify({
            query,
            variables: {
              accountId: account_id,
            },
          }),
        })

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`)
        }

        const data = await response.json()
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing GraphQL query: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    }
  )
} 