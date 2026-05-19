"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';

export default function Login() {
    const [login, setLogin] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const [showPassword, setShowPassword] = useState(false);
    const router = useRouter();

    const handleLogin = async () => {
        try {
        setError('')
        setLoading(true)
        const result = await signIn('credentials', {
            login,
            password,
            redirect: false,
        })

        if (result?.error) {
            setError('Invalid email/username or password')
        } else {
            router.push('/dashboard')
        }
        } catch (error) {
            setError('Something went wrong')
        console.log(error)
        } finally {
            setLoading(false)
        }
    }

    const handleGoogle = async () => {
        await signIn('google', { callbackUrl: '/dashboard' })
    }

    // Allow Enter key to submit
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleLogin()
    }

    return (
        <main className="min-h-screen bg-white dark:bg-gray-950 flex items-center justify-center px-6">
            <div className="w-full max-w-sm">

                {/* Logo */}
                <div className="flex flex-col items-center mb-8">
                <img
                    src="/images/icon.png"
                    alt="Logo"
                    className="w-20 h-20 rounded-full object-cover mb-3"
                />
                <h1 className="text-2xl font-bold text-gray-800 dark:text-white">BB 6th Sibu</h1>
                <p className="text-sm text-gray-500 dark:text-gray-400">Welcome back!</p>
                </div>

                {/* Card */}
                <div className="bg-gray-50 dark:bg-gray-900 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-gray-800">

                {/* Error message */}
                {error && (
                    <div className="mb-4 p-3 bg-red-50 dark:bg-red-900 rounded-xl">
                    <p className="text-red-500 text-xs">{error}</p>
                    </div>
                )}

                {/* Email or Username */}
                <div className="mb-4 floating-group">
                    <input
                    type="text"
                    placeholder=""
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="form-input floating-input"
                    />
                    <label className="form-label floating-label">
                        Email or Username
                    </label>
                </div>

                {/* Password */}
                <div className="mb-2 relative floating-group">
                        <input
                            type={showPassword ? 'text' : 'password'}
                            placeholder=""
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            onKeyDown={handleKeyDown}
                            className="form-input floating-input"
                        />
                        <label className="form-label floating-label">
                            Password
                        </label>
                        <button
                            type="button" // 记得加这个，防止点击时意外触发 form submit
                            onClick={() => setShowPassword(!showPassword)}
                            className="absolute right-3 top-3.5 text-gray-400 hover:text-blue-500 transition-colors"
                        >
                            <FontAwesomeIcon icon={showPassword ? faEyeSlash : faEye} className="text-lg" />
                        </button>
                </div>

                {/* Forgot Password */}
                {/* <div className="text-right mb-5">
                    <a href="/forgot-password" className="text-xs text-blue-500 hover:underline">
                    Forgot password?
                    </a>
                </div> */}

                {/* Login Button */}
                <button
                    onClick={handleLogin}
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium py-3 rounded-xl text-sm transition mb-3"
                >
                    {loading ? 'Logging in...' : 'Login'}
                </button>

                {/* Divider */}
                {/* <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"/>
                    <span className="text-xs text-gray-400">or continue with</span>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"/>
                </div> */}

                {/* Google Login */}
                {/* <button
                    onClick={handleGoogle}
                    className="w-full flex items-center justify-center gap-3 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-medium py-3 rounded-xl text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition"
                >
                    <svg width="18" height="18" viewBox="0 0 48 48">
                    <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.7 33.1 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 20-9 20-20 0-1.3-.1-2.7-.4-4z"/>
                    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34.1 6.5 29.3 4 24 4c-7.7 0-14.3 4.4-17.7 10.7z"/>
                    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.2C29.4 35.6 26.8 36 24 36c-5.2 0-9.7-2.9-11.9-7.2l-6.6 5.1C9.5 39.5 16.3 44 24 44z"/>
                    <path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.5-2.6 4.6-4.8 6l6.2 5.2C40.8 35.7 44 30.3 44 24c0-1.3-.1-2.7-.4-4z"/>
                    </svg>
                    Continue with Google
                </button> */}
                </div>

                {/* Register */}
                {/* <p className="text-center text-sm text-gray-500 dark:text-gray-400 mt-6">
                Don't have an account?{' '}
                <a href="/register" className="text-blue-500 font-medium hover:underline">
                    Register
                </a>
                </p> */}
            </div>
        </main>
    )
}