const isEdgeRuntime = typeof process !== 'undefined' && process.env.NEXT_RUNTIME === 'edge'

import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto'
import bcrypt from 'bcryptjs'

// Guard against Edge Runtime usage
if (isEdgeRuntime) {
  throw new Error('Encryption utilities require the Node.js runtime. Set runtime = "nodejs" for routes that use them.')
}

// Encryption key REQUIRED in production (see README for setup instructions)
// Skip validation during build or if explicitly disabled
const skipValidation = process.env.SKIP_ENV_VALIDATION === '1'

if (!skipValidation && !process.env.ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY must be set in production. See README for setup instructions.')
  } else {
    console.warn('WARNING: Using insecure ENCRYPTION_KEY for DEVELOPMENT only. See README for production setup.')
  }
}

// Get encryption key from environment or use insecure default for dev
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'DEV_ONLY_INSECURE_KEY_32BYTES!'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const MAX_PASSWORD_LENGTH = 128

/**
 * Validate that encryption key is configured properly (runtime check)
 */
function validateEncryptionKey(): void {
  // Skip validation during build or if explicitly disabled
  if (process.env.SKIP_ENV_VALIDATION === '1') {
    return
  }
  
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY must be set in production. See README for setup instructions.')
    }
    if (process.env.ENCRYPTION_KEY === 'DEV_ONLY_INSECURE_KEY_32BYTES!') {
      throw new Error('Production ENCRYPTION_KEY must not use default development value. Generate a secure key using: openssl rand -base64 32')
    }
  }
}

// Cached derived key — computed once at module initialization to avoid expensive
// scryptSync calls on every encrypt/decrypt operation.
let cachedEncryptionKey: Buffer | null = null

/**
 * Derive encryption key using scrypt (Key Derivation Function)
 * This is more secure than simple padding as it:
 * 1. Creates a consistent 32-byte key from any input length
 * 2. Uses a deterministic salt for consistent key generation
 * 3. Applies computational hardening (though minimal for performance)
 *
 * PERFORMANCE: The derived key is cached after the first call since the
 * ENCRYPTION_KEY and salt are fixed for the lifetime of the process.
 * This avoids blocking the event loop with scryptSync on every operation.
 */
function getEncryptionKey(): Buffer {
  if (cachedEncryptionKey) return cachedEncryptionKey

  // Use a fixed salt for deterministic key derivation
  // This ensures the same ENCRYPTION_KEY always produces the same derived key
  const salt = 'vitransfer-encryption-v1'

  // Use scrypt with minimal cost for fast key derivation
  // N=1024, r=8, p=1 provides good security with minimal performance impact
  cachedEncryptionKey = scryptSync(ENCRYPTION_KEY, salt, 32, {
    N: 1024,  // CPU/memory cost (lower = faster, still secure for deterministic derivation)
    r: 8,     // Block size
    p: 1      // Parallelization
  })

  return cachedEncryptionKey
}

/**
 * Encrypt sensitive data
 * @param text Plain text to encrypt
 * @returns Encrypted string in format: iv:authTag:encryptedData (hex)
 */
export function encrypt(text: string): string {
  if (!text) return ''
  
  validateEncryptionKey()
  
  try {
    const key = getEncryptionKey()
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    
    const authTag = cipher.getAuthTag()
    
    // Return format: iv:authTag:encryptedData
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
  } catch (error) {
    console.error('Encryption error:', error)
    throw new Error('Failed to encrypt data')
  }
}

/**
 * Decrypt sensitive data
 * @param encryptedText Encrypted string in format: iv:authTag:encryptedData
 * @returns Decrypted plain text
 */
export function decrypt(encryptedText: string): string {
  if (!encryptedText) return ''
  
  validateEncryptionKey()
  
  try {
    const key = getEncryptionKey()
    const parts = encryptedText.split(':')
    
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format')
    }
    
    const iv = Buffer.from(parts[0], 'hex')
    const authTag = Buffer.from(parts[1], 'hex')
    const encrypted = parts[2]
    
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    
    return decrypted
  } catch (error) {
    console.error('Decryption error:', error)
    throw new Error('Failed to decrypt data')
  }
}

/**
 * Hash a password using bcrypt
 * @param password Plain text password
 * @returns Hashed password
 */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`)
  }

  const salt = await bcrypt.genSalt(14)
  return bcrypt.hash(password, salt)
}

/**
 * Verify a password against a hash
 * @param password Plain text password
 * @param hash Hashed password
 * @returns True if password matches
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    return false
  }

  return bcrypt.compare(password, hash)
}

/**
 * Validate password strength
 * @param password Password to validate
 * @returns Object with isValid, errors, and strength
 */
export function validatePassword(password: string): { 
  isValid: boolean
  errors: string[]
  strength: 'weak' | 'medium' | 'strong'
} {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) {
    return {
      isValid: false,
      errors: [`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`],
      strength: 'weak',
    }
  }

  const errors: string[] = []
  
  // Length check (increased from 8 to 12)
  if (password.length < 12) {
    errors.push('Password must be at least 12 characters long')
  }
  
  // Character requirements
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  
  // Require special character
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character (!@#$%^&*)')
  }
  
  // Check against common passwords
  const commonPasswords = [
    'password', '123456', '12345678', 'qwerty', 'abc123',
    'monkey', '1234567', 'letmein', 'trustno1', 'dragon',
    'baseball', '111111', 'iloveyou', 'master', 'sunshine',
    'ashley', 'bailey', 'passw0rd', 'shadow', '123123',
    'football', 'jesus', 'michael', 'ninja', 'mustang',
    'password1', 'password123', 'admin', 'welcome', 'login'
  ]
  
  if (commonPasswords.includes(password.toLowerCase())) {
    errors.push('Password is too common. Please choose a stronger password')
  }
  
  // Check for repeated characters (e.g., "aaaa")
  if (/(.)\1{3,}/.test(password)) {
    errors.push('Password contains too many repeated characters')
  }
  
  // Check for sequential characters (e.g., "1234", "abcd")
  const sequences = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']
  const lowerPassword = password.toLowerCase()
  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - 4; i++) {
      const subseq = seq.substring(i, i + 4)
      if (lowerPassword.includes(subseq) || lowerPassword.includes(subseq.split('').reverse().join(''))) {
        errors.push('Password contains sequential characters')
        break
      }
    }
  }
  
  // Calculate strength
  let strength: 'weak' | 'medium' | 'strong' = 'weak'
  if (errors.length === 0) {
    if (password.length >= 16 && /[^A-Za-z0-9].*[^A-Za-z0-9]/.test(password)) {
      strength = 'strong' // 16+ chars with multiple special chars
    } else if (password.length >= 12) {
      strength = 'medium'
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    strength,
  }
}

