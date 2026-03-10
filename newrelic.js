'use strict'

exports.config = {
  app_name: ['Cocpit Backend'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: 'info'
  },
  distributed_tracing: {
    enabled: true
  }
}