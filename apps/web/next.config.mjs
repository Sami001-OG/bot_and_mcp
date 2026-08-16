const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingIncludes: {
    '/**/*': ['./prisma/generated/client/**'],
  },
};

export default config;
