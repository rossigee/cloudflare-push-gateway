# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-14

### Security
- Use constant-time comparison for Basic Auth passwords and API tokens to prevent timing attacks

### Fixed
- Replace broken/incomplete ICO favicon with valid inline SVG
- Return generic 500 message instead of leaking internal error details to clients

### Performance
- Fix N+1 Durable Object storage reads in `/list-structured` — now resolved in a single `list()` call

### Changed
- Extract `withAuth` middleware, eliminating repeated auth boilerplate in the router
- Replace `switch(true)` router with `if/else if` chain
- Extract `renderFooter()` to remove duplicated footer HTML across pages
- Add `Allow` header on 405 Method Not Allowed responses per HTTP spec

## [0.1.1] - 2026-05-09

### Added
- Comprehensive REST API documentation at `/docs` endpoint
- Structured API reference with endpoint specifications, parameters, and examples
- Improved footer navigation with better styling across all pages

### Changed
- Switched UI to dark theme for better visual appeal
- Enhanced authentication documentation with detailed setup instructions
- Improved footer navigation presentation with hover effects and consistent styling
- Moved navigation links to footer for cleaner header layout
- Added "Usage Docs" link in top-right corner of homepage
- Updated API documentation to follow REST API reference format

### Fixed
- Added authentication bypass for localhost requests to support testing
- Improved documentation structure and organization

### Technical
- Modified authentication logic to allow localhost access in test environments
- Added comprehensive API endpoint documentation
- Enhanced CSS styling for better dark theme support</content>
<parameter name="filePath">CHANGELOG.md