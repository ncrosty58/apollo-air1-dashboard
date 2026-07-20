FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN adduser --disabled-password --gecos '' appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . .
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 5858

# Liveness check hits /healthz (no InfluxDB/MQTT dependency), using stdlib so
# the slim image needs no curl. start-period gives gunicorn time to boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5858/healthz', timeout=4).status==200 else 1)"]

# Production server by default so the bare image doesn't fall back to Flask's
# dev server. docker-compose overrides this, but this keeps `docker run` sane.
CMD ["gunicorn", "-w", "1", "--threads", "8", "--timeout", "60", "-b", "0.0.0.0:5858", "app:app"]
