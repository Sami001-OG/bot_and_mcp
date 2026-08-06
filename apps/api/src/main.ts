import 'reflect-metadata';
import './env.js';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ArgumentsHost, Catch, ExceptionFilter, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { AppModule } from './modules.js';

@Catch(ZodError)
class ZodErrorFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(400).json({ statusCode: 400, message: 'Validation failed', issues: exception.issues });
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api/v1');
  app.use(helmet({ contentSecurityPolicy: true }));
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:3001').split(','), credentials: true });
  app.use((req: IncomingMessage, res: ServerResponse, next: () => void) => { const id = String(req.headers['x-correlation-id'] ?? randomUUID()); res.setHeader('x-correlation-id', id); next(); });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ZodErrorFilter());
  const config = new DocumentBuilder().setTitle('Trading Platform API').setVersion('1.0').addBearerAuth().addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'idempotency').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT ?? 4000), '0.0.0.0');
}
bootstrap().catch((error) => { console.error(error); process.exitCode = 1; });
