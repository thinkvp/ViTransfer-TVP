'use client'

import { useMemo } from 'react'
import { Check, X } from 'lucide-react'

interface PasswordRequirementsProps {
  password: string
  className?: string
}

interface Requirement {
  label: string
  test: (password: string) => boolean
}

const commonPasswords = [
  'password', '123456', '12345678', 'qwerty', 'abc123',
  'monkey', '1234567', 'letmein', 'trustno1', 'dragon',
  'baseball', '111111', 'iloveyou', 'master', 'sunshine',
  'ashley', 'bailey', 'passw0rd', 'shadow', '123123',
  'football', 'jesus', 'michael', 'ninja', 'mustang',
  'password1', 'password123', 'admin', 'welcome', 'login'
]

const sequences = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

function hasSequentialChars(password: string): boolean {
  const lower = password.toLowerCase()
  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - 4; i++) {
      const subseq = seq.substring(i, i + 4)
      if (lower.includes(subseq) || lower.includes(subseq.split('').reverse().join(''))) {
        return true
      }
    }
  }
  return false
}

const requirements: Requirement[] = [
  {
    label: 'At least 12 characters',
    test: (pwd) => pwd.length >= 12,
  },
  {
    label: 'One uppercase letter (A-Z)',
    test: (pwd) => /[A-Z]/.test(pwd),
  },
  {
    label: 'One lowercase letter (a-z)',
    test: (pwd) => /[a-z]/.test(pwd),
  },
  {
    label: 'One number (0-9)',
    test: (pwd) => /[0-9]/.test(pwd),
  },
  {
    label: 'One special character (!@#$%^&*...)',
    test: (pwd) => /[^A-Za-z0-9]/.test(pwd),
  },
  {
    label: 'Not a common password',
    test: (pwd) => pwd.length === 0 || !commonPasswords.includes(pwd.toLowerCase()),
  },
  {
    label: 'No repeated characters (e.g. aaaa)',
    test: (pwd) => pwd.length === 0 || !/(.)\1{3,}/.test(pwd),
  },
  {
    label: 'No sequential characters (e.g. abcd, 1234)',
    test: (pwd) => pwd.length === 0 || !hasSequentialChars(pwd),
  },
]

export function PasswordRequirements({ password, className = '' }: PasswordRequirementsProps) {
  const results = useMemo(() => {
    return requirements.map((req) => ({
      ...req,
      passed: req.test(password),
    }))
  }, [password])

  const allPassed = results.every((r) => r.passed)

  return (
    <div className={`space-y-2 ${className}`}>
      <p className="text-sm font-medium text-foreground">Password Requirements:</p>
      <ul className="space-y-1">
        {results.map((result, index) => (
          <li
            key={index}
            className={`flex items-center gap-2 text-sm transition-colors ${
              result.passed ? 'text-success' : 'text-muted-foreground'
            }`}
          >
            {result.passed ? (
              <Check className="w-4 h-4 flex-shrink-0" />
            ) : (
              <X className="w-4 h-4 flex-shrink-0 opacity-30" />
            )}
            <span className={result.passed ? 'font-medium' : ''}>{result.label}</span>
          </li>
        ))}
      </ul>
      {allPassed && password.length > 0 && (
        <p className="text-sm text-success font-medium mt-2 flex items-center gap-1">
          <Check className="w-4 h-4" /> Password meets all requirements
        </p>
      )}
    </div>
  )
}
