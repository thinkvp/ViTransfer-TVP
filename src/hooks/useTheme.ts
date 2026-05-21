'use client'

import { useEffect, useState } from 'react'

// Always return dark mode
export function useTheme(): { theme: 'dark'; isDark: true } {
  return { theme: 'dark', isDark: true }
}
