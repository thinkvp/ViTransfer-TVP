import type { Account, AccountTaxCode, AccountType } from './types'
import { ACCOUNT_TYPE_LABELS } from './types'

type AccountNode = Pick<Account, 'id' | 'code' | 'name' | 'type' | 'taxCode' | 'parentId'> & {
  children?: AccountNode[]
}

export interface AccountOption {
  id: string
  code: string
  name: string
  type: AccountType
  taxCode: AccountTaxCode
  parentId: string | null
  label: string
  searchText: string
}

function collectAccounts(accounts: AccountNode[], byId: Map<string, AccountNode>) {
  for (const account of accounts) {
    if (!byId.has(account.id)) {
      byId.set(account.id, account)
    }
    if (account.children?.length) {
      collectAccounts(account.children, byId)
    }
  }
}

function getAccountNamePath(account: AccountNode, byId: Map<string, AccountNode>) {
  const names: string[] = [account.name]
  const visited = new Set<string>([account.id])
  let parentId = account.parentId

  while (parentId) {
    const parent = byId.get(parentId)
    if (!parent || visited.has(parent.id)) {
      break
    }
    names.unshift(parent.name)
    visited.add(parent.id)
    parentId = parent.parentId
  }

  return names.join(' - ')
}

export function buildAccountOptions(accounts: AccountNode[]): AccountOption[] {
  const byId = new Map<string, AccountNode>()
  collectAccounts(accounts, byId)

  return [...byId.values()]
    .map(account => {
      const typeLabel = ACCOUNT_TYPE_LABELS[account.type]
      const namePath = getAccountNamePath(account, byId)
      const label = `${typeLabel} - ${namePath}`

      return {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        taxCode: account.taxCode,
        parentId: account.parentId,
        label,
        searchText: [account.code, account.name, namePath, label, typeLabel].join(' ').toLowerCase(),
      }
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}