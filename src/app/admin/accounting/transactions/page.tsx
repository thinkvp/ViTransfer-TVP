import { redirect } from 'next/navigation'

export default function TransactionsPage() {
  redirect('/admin/accounting/bank-accounts')
}

